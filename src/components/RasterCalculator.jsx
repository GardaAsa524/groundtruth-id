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
/**
 * Tebakan awal urutan pita. Ini TEBAKAN, bukan pembacaan — GeoTIFF tidak
 * mewajibkan penamaan pita, dan urutannya berbeda antarsumber:
 *
 *   Ortofoto UAV (Pix4D, Agisoft, ODM)  : R, G, B, alpha
 *   PlanetScope 4-band                   : B, G, R, NIR
 *   Sentinel-2 tersusun                  : bergantung urutan ekspor
 *
 * Versi sebelumnya memaksa BGRN untuk semua berkas 4-pita, sehingga ortofoto
 * drone diperlakukan terbalik dan NDVI-nya menghitung sesuatu yang tidak ada
 * artinya. Sekarang bawaannya urutan RGB — yang paling lazim untuk data
 * lapangan di aplikasi ini — dan pengguna dapat mengubahnya di antarmuka.
 */
const DEFAULT_ROLES = {
  1: ['gray'],
  3: ['red', 'green', 'blue'],
  4: ['red', 'green', 'blue', 'alpha'],
  6: ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'],
};

/** Peran yang dapat dipilih pengguna untuk tiap pita. */
export const BAND_ROLES = ['red', 'green', 'blue', 'nir', 'swir1', 'swir2', 'alpha', 'gray', '—'];

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

      const guess = DEFAULT_ROLES[bandCount] ?? [];
      const bands = {};
      const bandNames = [];
      const rawNames = [];
      for (let i = 0; i < rasters.length; i++) {
        const generic = `b${i + 1}`;
        const arr = rasters[i] instanceof Float32Array
          ? rasters[i]
          : Float32Array.from(rasters[i]);
        bands[generic] = arr;
        bandNames.push(generic);
        rawNames.push(generic);
      }
      // Peran awal; dapat diubah pengguna lewat panel pemetaan pita.
      const roles = {};
      rawNames.forEach((b, i) => { roles[b] = guess[i] ?? '—'; });

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
          rawNames,
          roles,
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
  const { t, nf } = useLocale();

  // Mode tampilan. 'rgb' didahulukan karena hal pertama yang ingin dilihat
  // orang setelah memuat ortofoto adalah citranya sendiri, bukan indeks.
  const [mode, setMode] = useState('rgb');
  const [roles, setRoles] = useState({});
  const [expr, setExpr] = useState('(nir - red) / (nir + red)');
  const [colormap, setColormap] = useState('rdylgn');
  const [opacity, setOpacity] = useState(1);
  const [gamma, setGamma] = useState(1);
  const [stretch, setStretch] = useState({ mode: 'percentile', min: -1, max: 1 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const canvasRef = useRef(null);
  const rendererRef = useRef(null);

  // Setel peran pita saat berkas baru dimuat.
  useEffect(() => {
    if (tiff?.roles) setRoles(tiff.roles);
    if (tiff) setMode(tiff.bandCount >= 3 ? 'rgb' : 'index');
  }, [tiff]);

  /** Pita yang ditugasi peran tertentu, mis. peranPita('red') -> 'b1'. */
  const bandFor = useCallback(
    (role) => Object.keys(roles).find((b) => roles[b] === role) ?? null,
    [roles]
  );

  // Nama yang dapat dipakai di ekspresi: nama mentah plus peran yang terpasang.
  const exprBands = useMemo(() => {
    if (!tiff) return [];
    const named = Object.values(roles).filter((r) => r && r !== '—');
    return [...tiff.rawNames, ...named];
  }, [tiff, roles]);

  const parsed = useMemo(() => {
    if (!tiff || mode !== 'index') return { ok: true, usedBands: [] };
    try {
      return { ok: true, ...parseExpression(expr, { bands: exprBands }) };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }, [expr, tiff, exprBands, mode]);

  const rgbReady = mode !== 'rgb' || (bandFor('red') && bandFor('green') && bandFor('blue'));

  const run = useCallback(async () => {
    if (!tiff) return;
    setBusy(true);
    setError(null);
    try {
      let canvas = canvasRef.current;
      if (!canvas) { canvas = document.createElement('canvas'); canvasRef.current = canvas; }
      if (!rendererRef.current) rendererRef.current = new RasterGLRenderer(canvas);
      const r = rendererRef.current;

      if (mode === 'rgb') {
        const rb = bandFor('red'), gb = bandFor('green'), bb = bandFor('blue');
        const ab = bandFor('alpha');
        const used = [rb, gb, bb, ab].filter(Boolean);
        for (const name of used) r.uploadBand(name, tiff.bands[name], tiff.width, tiff.height);
        r.releaseUnused(used);

        // Peregangan dihitung terpisah per saluran. Memakai satu rentang
        // untuk ketiganya membuat ortofoto tampak berwarna semu, karena pita
        // biru pada citra udara hampir selalu berentang jauh lebih sempit.
        const st = [rb, gb, bb].map((b) =>
          sampleStats(tiff.bands[b], { lowPct: 2, highPct: 98, nodata: tiff.nodata }));
        r.compileRGB({ r: rb, g: gb, b: bb, alpha: ab }, { hasNoData: tiff.nodata !== null });
        r.renderRGB({
          min: st.map((x) => x.min),
          max: st.map((x) => x.max),
          opacity, nodata: tiff.nodata, gamma,
          // Piksel alpha nol pada ortofoto adalah area di luar jangkauan
          // pemotretan; tanpa ini, tepinya tampil sebagai kotak hitam.
          alphaCutoff: ab ? st[0].max * 0.02 : 0,
        });
      } else {
        if (!parsed.ok) throw new Error(parsed.message);
        const uniq = [];
        const seen = new Set();
        for (const name of parsed.usedBands) {
          const real = tiff.bands[name] ? name : bandFor(name);
          const arr = tiff.bands[real];
          if (!arr) throw new Error(`Pita "${name}" belum dipetakan.`);
          if (seen.has(arr)) continue;
          seen.add(arr); uniq.push(real);
        }
        // Sediakan alias peran supaya ekspresi boleh memakai kata 'nir'.
        const aliasMap = {};
        for (const name of parsed.usedBands) {
          aliasMap[name] = tiff.bands[name] ? name : bandFor(name);
        }
        for (const name of uniq) r.uploadBand(name, tiff.bands[name], tiff.width, tiff.height);
        r.releaseUnused(uniq);

        let min = stretch.min, max = stretch.max;
        if (stretch.mode === 'percentile') {
          const n = tiff.width * tiff.height;
          const step = Math.max(1, Math.floor(n / 50000));
          const vals = new Float64Array(Math.ceil(n / step));
          const env = {}; let k = 0;
          for (let i = 0; i < n; i += step) {
            let bad = false;
            for (const name of parsed.usedBands) {
              const v = tiff.bands[aliasMap[name]][i];
              if (tiff.nodata !== null && Math.abs(v - tiff.nodata) < 1e-9) { bad = true; break; }
              env[name] = v;
            }
            vals[k++] = bad ? NaN : evaluate(parsed.ast, env);
          }
          const st = sampleStats(vals.subarray(0, k));
          min = st.min; max = st.max;
          setStretch((x) => ({ ...x, min, max }));
        }

        // AST memakai nama peran; shader memakai nama pita. Terjemahkan.
        const astBands = parsed.usedBands.map((n) => aliasMap[n]);
        const renamed = JSON.parse(JSON.stringify(parsed.ast));
        (function rename(node) {
          if (!node || typeof node !== 'object') return;
          if (node.k === 'band') node.name = aliasMap[node.name] ?? node.name;
          for (const key of ['a', 'b']) rename(node[key]);
          (node.args ?? []).forEach(rename);
        })(renamed);

        r.compile(renamed, [...new Set(astBands)], { hasNoData: tiff.nodata !== null });
        r.render({ min, max, colormap, opacity, nodata: tiff.nodata });
      }

      onLayerReady?.({
        url: canvas.toDataURL('image/png'),
        bbox: tiff.bbox, epsg: tiff.epsg,
        expression: mode === 'rgb' ? 'RGB' : expr,
        mode,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [tiff, mode, roles, bandFor, parsed, stretch.mode, stretch.min, stretch.max,
      colormap, opacity, gamma, expr, onLayerReady]);

  useEffect(() => () => rendererRef.current?.dispose(), []);

  if (!tiff) return <p className="gt-hint">{t('raster.noFile')}</p>;

  return (
    <div className="gt-raster-calc">
      <div className="gt-seg gt-full-seg">
        <button type="button" className={mode === 'rgb' ? 'is-on' : ''}
          onClick={() => setMode('rgb')}>{t('raster.modeRGB')}</button>
        <button type="button" className={mode === 'index' ? 'is-on' : ''}
          onClick={() => setMode('index')}>{t('raster.modeIndex')}</button>
      </div>

      {/* Pemetaan pita: satu-satunya cara jujur menangani GeoTIFF, karena
          formatnya tidak menyimpan nama pita dan urutannya berbeda-beda. */}
      <details className="gt-details" open={mode === 'rgb'}>
        <summary>{t('raster.bandMapping')}</summary>
        <div className="gt-band-map">
          {tiff.rawNames.map((b) => (
            <label key={b}>
              <span className="mono">{b}</span>
              <select value={roles[b] ?? '—'}
                onChange={(e) => setRoles((r) => ({ ...r, [b]: e.target.value }))}>
                {BAND_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
          ))}
        </div>
        <p className="gt-hint">{t('raster.bandMappingHint')}</p>
      </details>

      {mode === 'index' && (
        <>
          <div className="gt-field">
            <label htmlFor="gt-expr">{t('raster.expression')}</label>
            <textarea id="gt-expr" rows={2} spellCheck={false}
              className={`gt-expr-input mono${parsed.ok ? '' : ' is-invalid'}`}
              value={expr} onChange={(e) => setExpr(e.target.value)} />
            {!parsed.ok && <p className="gt-gps-alert" role="alert">{parsed.message}</p>}
          </div>

          <div className="gt-chips">
            {INDEX_PRESETS.map((p) => (
              <button key={p.id} type="button" className="gt-chip" title={p.note}
                onClick={() => { setExpr(p.expr); setStretch({ mode: 'fixed', min: p.range[0], max: p.range[1] }); }}>
                {p.label}
              </button>
            ))}
          </div>

          <p className="gt-hint">
            {t('raster.availableBands')}: <span className="mono">{exprBands.join(', ')}</span>
          </p>

          <div className="gt-row">
            <label>{t('raster.colormap')}
              <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
                {Object.keys(COLORMAPS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label>{t('raster.stretch')}
              <select value={stretch.mode}
                onChange={(e) => setStretch((s2) => ({ ...s2, mode: e.target.value }))}>
                <option value="percentile">{t('raster.stretchPercentile')}</option>
                <option value="fixed">{t('raster.stretchFixed')}</option>
              </select>
            </label>
          </div>

          {stretch.mode === 'fixed' && (
            <div className="gt-row">
              <label>min<input type="number" step="0.1" value={stretch.min}
                onChange={(e) => setStretch((s2) => ({ ...s2, min: parseFloat(e.target.value) }))} /></label>
              <label>max<input type="number" step="0.1" value={stretch.max}
                onChange={(e) => setStretch((s2) => ({ ...s2, max: parseFloat(e.target.value) }))} /></label>
            </div>
          )}
        </>
      )}

      {mode === 'rgb' && (
        <label className="gt-slider">
          {t('raster.gamma')} {gamma.toFixed(2)}
          <input type="range" min="0.4" max="2.2" step="0.05" value={gamma}
            onChange={(e) => setGamma(parseFloat(e.target.value))} />
        </label>
      )}

      <label className="gt-slider">
        {t('raster.opacity')} {Math.round(opacity * 100)}%
        <input type="range" min="0" max="1" step="0.05" value={opacity}
          onChange={(e) => setOpacity(parseFloat(e.target.value))} />
      </label>

      <button type="button" className="gt-btn-primary"
        disabled={busy || !rgbReady || (mode === 'index' && !parsed.ok)}
        onClick={run}>
        {busy ? t('raster.computing') : t('raster.compute')}
      </button>

      {!rgbReady && <p className="gt-gps-alert">{t('raster.needRGB')}</p>}
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
          <div><dt>EPSG</dt><dd className="mono">{tiff.epsg ?? '—'}</dd></div>
          <div><dt>NoData</dt><dd className="mono">{tiff.nodata ?? '—'}</dd></div>
        </dl>
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
    // bounds ikut dilaporkan supaya panel lapisan dapat menyediakan
    // "zoom ke lapisan" tanpa menghitung ulang reproyeksinya.
    onGeometryInfo?.({ ok: true, reprojected, crs: descriptor, bounds, ...skew });

    const layer = L.imageOverlay(result.url, L.latLngBounds(bounds), {
      opacity, interactive: false,
    });
    layer.addTo(map);
    ref.current = layer;
    // Zoom otomatis hanya pada pemuatan pertama. Menggeser paksa peta setiap
    // kali pengguna menghitung ulang indeks sangat mengganggu saat mereka
    // sedang memeriksa satu bagian citra.
    if (!ref.firstDone) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [16, 16] });
      ref.firstDone = true;
    }

    return () => { map.removeLayer(layer); ref.current = null; };
  }, [result, map]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { ref.current?.setOpacity(opacity); }, [opacity]);
  return null;
}
