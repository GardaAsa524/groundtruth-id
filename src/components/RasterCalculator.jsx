/**
 * components/RasterCalculator.jsx
 * ---------------------------------------------------------------------------
 * Antarmuka aljabar peta.
 *
 * ALIRAN DATA
 *   GeoTIFF -> geotiff.js (dibaca pada ukuran kerja aman, bukan resolusi penuh)
 *   -> Float32Array per pita -> tekstur R32F -> shader hasil kompilasi AST
 *   -> kanvas RGBA -> L.imageOverlay pada bounds GeoTIFF
 *
 * Overlay memakai imageOverlay, bukan GridLayer seperti GeoPDF, karena GeoTIFF
 * yang diunggah pengguna hampir selalu sudah dalam EPSG:4326 atau UTM lokal
 * dengan cakupan kecil, sehingga simpangan konvergensi di bawah satu piksel.
 * Bila berkasnya lintas zona atau berukuran benua, jalur GridLayer yang sama
 * dapat dipakai ulang — itu sebabnya keduanya berbagi modul affine.
 */

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { parseExpression, evaluate, INDEX_PRESETS } from '../core/raster/expression.js';
import { RasterGLRenderer, sampleStats, planWorkingSize, renderCPU } from '../core/raster/renderer.js';
import { COLORMAPS } from '../core/raster/glsl.js';
import { bboxToLatLngBounds, estimateOverlaySkew } from '../core/geo/bounds.js';
import { useLocale } from '../context/AppProviders.jsx';

/**
 * Nama pita yang ramah manusia.
 * Menulis `(b8 - b4) / (b8 + b4)` mudah salah; `(nir - red) / (nir + red)`
 * langsung terbaca. Kita sediakan keduanya sebagai alias ke indeks pita yang sama.
 */
const COMMON_ALIASES = {
  4: ['blue', 'green', 'red', 'nir'],
  6: ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'],
  3: ['red', 'green', 'blue'],
};

export function useGeoTIFF() {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  const load = useCallback(async (file, { maxWorkingPixels = 4e6 } = {}) => {
    setState({ status: 'loading', data: null, error: null });
    try {
      const { fromArrayBuffer } = await import('geotiff');
      const buf = await file.arrayBuffer();
      const tiff = await fromArrayBuffer(buf);
      const image = await tiff.getImage();

      const fullW = image.getWidth();
      const fullH = image.getHeight();
      const bandCount = image.getSamplesPerPixel();

      // Rencanakan ukuran SEBELUM membaca. readRasters() dengan width/height
      // memakai piramida internal bila ada, sehingga desimasi terjadi di dalam
      // pustaka dan bukan setelah 400 MB mendarat di heap.
      const plan = planWorkingSize(fullW, fullH, { maxWorkingPixels, bandCount });

      const rasters = await image.readRasters({
        width: plan.width,
        height: plan.height,
        interleave: false,
      });

      const bbox = image.getBoundingBox();           // [minX, minY, maxX, maxY]
      const nodata = image.getGDALNoData();
      const fd = image.getFileDirectory();
      const epsg = image.geoKeys?.ProjectedCSTypeGeoKey
        ?? image.geoKeys?.GeographicTypeGeoKey ?? null;

      const aliases = COMMON_ALIASES[bandCount] ?? [];
      const bands = {};
      const bandNames = [];
      for (let i = 0; i < rasters.length; i++) {
        const generic = `b${i + 1}`;
        const arr = rasters[i] instanceof Float32Array
          ? rasters[i]
          : Float32Array.from(rasters[i]);
        bands[generic] = arr;
        bandNames.push(generic);
        if (aliases[i]) { bands[aliases[i]] = arr; bandNames.push(aliases[i]); }
      }

      setState({
        status: 'ready',
        error: null,
        data: {
          width: plan.width,
          height: plan.height,
          fullWidth: fullW,
          fullHeight: fullH,
          decimation: plan.decimation,
          bandCount,
          bands,
          bandNames,
          bbox,
          epsg,
          nodata,
          bitsPerSample: fd.BitsPerSample?.[0] ?? null,
        },
      });
    } catch (err) {
      setState({ status: 'error', data: null, error: err.message });
    }
  }, []);

  return { ...state, load };
}

export function RasterCalculator({ tiff, onLayerReady }) {
  const { t } = useLocale();
  const [expr, setExpr] = useState('(nir - red) / (nir + red)');
  const [colormap, setColormap] = useState('rdylgn');
  const [opacity, setOpacity] = useState(0.85);
  const [stretch, setStretch] = useState({ mode: 'percentile', min: -1, max: 1 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [glslPreview, setGlslPreview] = useState('');

  const canvasRef = useRef(null);
  const rendererRef = useRef(null);

  // Validasi berjalan pada setiap ketikan tetapi hanya menguraikan — tidak
  // merender. Menguraikan ekspresi 60 karakter memerlukan mikrodetik, jadi
  // umpan balik galat bisa seketika tanpa debounce.
  const parsed = useMemo(() => {
    if (!tiff) return { ok: false };
    try {
      const r = parseExpression(expr, { bands: tiff.bandNames });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }, [expr, tiff]);

  const run = useCallback(async () => {
    if (!tiff || !parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      // Pita unik saja: `nir` dan `b4` bisa menunjuk array yang sama.
      const uniq = [];
      const seen = new Set();
      for (const name of parsed.usedBands) {
        const arr = tiff.bands[name];
        if (seen.has(arr)) continue;
        seen.add(arr);
        uniq.push(name);
      }

      // Rentang peregangan
      let min = stretch.min;
      let max = stretch.max;
      if (stretch.mode === 'percentile') {
        // Hitung nilai indeks pada cuplikan piksel, bukan seluruhnya.
        const n = tiff.width * tiff.height;
        const step = Math.max(1, Math.floor(n / 50000));
        const vals = new Float64Array(Math.ceil(n / step));
        const env = {};
        let k = 0;
        for (let i = 0; i < n; i += step) {
          let bad = false;
          for (const b of parsed.usedBands) {
            const v = tiff.bands[b][i];
            if (tiff.nodata !== null && Math.abs(v - tiff.nodata) < 1e-9) { bad = true; break; }
            env[b] = v;
          }
          vals[k++] = bad ? NaN : evaluate(parsed.ast, env);
        }
        const s = sampleStats(vals.subarray(0, k), { lowPct: 2, highPct: 98 });
        min = s.min; max = s.max;
        setStretch((st) => ({ ...st, min, max }));
      }

      let canvas = canvasRef.current;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvasRef.current = canvas;
      }

      let usedGPU = true;
      try {
        if (!rendererRef.current) rendererRef.current = new RasterGLRenderer(canvas);
        const r = rendererRef.current;
        for (const name of uniq) {
          r.uploadBand(name, tiff.bands[name], tiff.width, tiff.height);
        }
        r.releaseUnused(uniq);
        const { exprSrc } = r.compile(parsed.ast, uniq, { hasNoData: tiff.nodata !== null });
        setGlslPreview(exprSrc);
        r.render({ min, max, colormap, opacity, nodata: tiff.nodata });
      } catch (glErr) {
        // Jalur cadangan CPU. Lebih lambat, tetapi lebih baik daripada halaman
        // kosong pada perangkat dengan GPU yang di-blacklist peramban.
        usedGPU = false;
        console.warn('WebGL gagal, beralih ke CPU:', glErr.message);
        canvas.width = tiff.width;
        canvas.height = tiff.height;
        const ctx = canvas.getContext('2d');
        const img = renderCPU({
          evaluateFn: evaluate, ast: parsed.ast, bandData: tiff.bands,
          bands: parsed.usedBands, width: tiff.width, height: tiff.height,
          min, max, colormap, opacity, nodata: tiff.nodata,
        });
        ctx.putImageData(img, 0, 0);
      }

      const url = canvas.toDataURL('image/png');
      onLayerReady?.({
        url, bbox: tiff.bbox, epsg: tiff.epsg,
        stats: { min, max }, expression: expr, usedGPU,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [tiff, parsed, stretch.mode, stretch.min, stretch.max, colormap, opacity, expr, onLayerReady]);

  useEffect(() => () => rendererRef.current?.dispose(), []);

  if (!tiff) return <p className="gt-hint">{t('raster.noFile')}</p>;

  return (
    <div className="gt-raster-calc">
      <div className="gt-field">
        <label htmlFor="gt-expr">{t('raster.expression')}</label>
        <textarea
          id="gt-expr"
          className={`gt-expr-input mono${parsed.ok ? '' : ' is-invalid'}`}
          value={expr}
          spellCheck={false}
          rows={2}
          onChange={(e) => setExpr(e.target.value)}
        />
        {!parsed.ok && <p className="gt-gps-alert" role="alert">{parsed.message}</p>}
        {parsed.ok && (
          <p className="gt-hint mono">
            {t('raster.usedBands')}: {parsed.usedBands.join(', ') || '—'}
          </p>
        )}
      </div>

      <div className="gt-chips">
        {INDEX_PRESETS.map((p) => (
          <button key={p.id} type="button" className="gt-chip"
            title={p.note} onClick={() => { setExpr(p.expr); setStretch({ mode: 'fixed', min: p.range[0], max: p.range[1] }); }}>
            {p.label}
          </button>
        ))}
      </div>

      <p className="gt-hint">
        {t('raster.availableBands')}: <span className="mono">{tiff.bandNames.join(', ')}</span>
      </p>

      <div className="gt-row">
        <label>
          {t('raster.colormap')}
          <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
            {Object.keys(COLORMAPS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label>
          {t('raster.stretch')}
          <select value={stretch.mode} onChange={(e) => setStretch((s) => ({ ...s, mode: e.target.value }))}>
            <option value="percentile">{t('raster.stretchPercentile')}</option>
            <option value="fixed">{t('raster.stretchFixed')}</option>
          </select>
        </label>
      </div>

      {stretch.mode === 'fixed' && (
        <div className="gt-row">
          <label>min<input type="number" step="0.1" value={stretch.min}
            onChange={(e) => setStretch((s) => ({ ...s, min: parseFloat(e.target.value) }))} /></label>
          <label>max<input type="number" step="0.1" value={stretch.max}
            onChange={(e) => setStretch((s) => ({ ...s, max: parseFloat(e.target.value) }))} /></label>
        </div>
      )}

      <label className="gt-slider">
        {t('raster.opacity')} {Math.round(opacity * 100)}%
        <input type="range" min="0" max="1" step="0.05" value={opacity}
          onChange={(e) => setOpacity(parseFloat(e.target.value))} />
      </label>

      <button type="button" className="gt-btn-primary" disabled={!parsed.ok || busy} onClick={run}>
        {busy ? t('raster.computing') : t('raster.compute')}
      </button>

      {error && <p className="gt-gps-alert" role="alert">{error}</p>}

      <details className="gt-details">
        <summary>{t('raster.sourceInfo')}</summary>
        <dl className="gt-quality">
          <div><dt>{t('raster.fullSize')}</dt>
            <dd className="mono">{tiff.fullWidth} × {tiff.fullHeight}</dd></div>
          <div><dt>{t('raster.workingSize')}</dt>
            <dd className="mono">{tiff.width} × {tiff.height}
              {tiff.decimation > 1 && ` (1:${tiff.decimation.toFixed(1)})`}</dd></div>
          <div><dt>{t('raster.bands')}</dt><dd className="mono">{tiff.bandCount}</dd></div>
          <div><dt>NoData</dt><dd className="mono">{tiff.nodata ?? '—'}</dd></div>
        </dl>
        {glslPreview && (
          <pre className="gt-code">{glslPreview}</pre>
        )}
      </details>
    </div>
  );
}

/**
 * Menempatkan hasil kalkulasi sebagai overlay.
 *
 * Catatan yang jujur tentang keterbatasannya: imageOverlay meregangkan citra ke
 * kotak lintang-bujur, sehingga cara ini mengabaikan konvergensi meridian —
 * masalah yang sama dengan yang dihindari GeoPDFGridLayer. Untuk citra kecil
 * (di bawah beberapa kilometer) simpangannya di bawah satu piksel dan tidak
 * relevan. Untuk cakupan puluhan kilometer, simpangan sudutnya bisa puluhan
 * meter, dan `warnConvergence` menandainya supaya pengguna tahu.
 */
export function RasterResultLayer({ result, opacity = 1, onGeometryInfo }) {
  const map = useMap();
  const ref = useRef(null);

  useEffect(() => {
    if (!result || !map) return undefined;

    const { bounds, reprojected, descriptor, error } =
      bboxToLatLngBounds(result.bbox, result.epsg);

    if (!bounds) {
      onGeometryInfo?.({ ok: false, error: error ?? 'Bbox GeoTIFF tidak dapat diproyeksikan.' });
      return undefined;
    }

    const skew = estimateOverlaySkew(bounds, descriptor);
    onGeometryInfo?.({ ok: true, reprojected, crs: descriptor, ...skew });

    const layer = L.imageOverlay(result.url, L.latLngBounds(bounds), {
      opacity, interactive: false,
    });
    layer.addTo(map);
    ref.current = layer;
    map.fitBounds(L.latLngBounds(bounds), { padding: [16, 16] });

    return () => { map.removeLayer(layer); ref.current = null; };
  }, [result, map]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { ref.current?.setOpacity(opacity); }, [opacity]);
  return null;
}
