/**
 * components/GeoPDFLayer.jsx
 * ---------------------------------------------------------------------------
 * Perekat antara parser GeoPDF, rasterizer pdf.js, dan peta Leaflet.
 *
 * Rangkaian kerja saat pengguna memilih berkas:
 *   1. berkas -> ArrayBuffer (sekali, dipakai dua pustaka)
 *   2. pdf-lib  -> kamus /VP /Measure /GEO   (parseGeoPDF)
 *   3. buildGeoref -> matriks affine + mutu kecocokan
 *   4. chooseRenderScale -> DPI yang aman bagi memori
 *   5. pdf.js  -> kanvas luring
 *   6. GeoPDFGridLayer -> ubin yang di-resample per tampilan
 *
 * Langkah 5 dijalankan di dalam requestIdleCallback berjenjang supaya halaman
 * tidak membeku pada lembar A0 beresolusi tinggi.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { parseGeoPDF } from '../core/geopdf/parseGeoPDF.js';
import { buildGeoref, userToCanvasMatrix, crsToCanvasMatrix, chooseRenderScale } from '../core/geopdf/georefModel.js';
import { createGeoPDFGridLayer, georefBounds } from '../core/geopdf/GeoPDFGridLayer.js';

/**
 * Memuat pustaka berat hanya ketika benar-benar dibutuhkan.
 * pdf.js + pdf-lib berukuran ~1.2 MB tergzip; memuatnya di bundel utama
 * memperlambat pemuatan pertama untuk pengguna yang tidak pernah membuka PDF.
 */
async function loadPdfLibs() {
  const [{ PDFDocument }, pdfjs] = await Promise.all([
    import('pdf-lib'),
    import('pdfjs-dist'),
  ]);
  // Worker wajib dikonfigurasi; tanpa ini pdf.js merender di thread utama
  // dan membekukan antarmuka selama beberapa detik.
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return { PDFDocument, pdfjs };
}

export function useGeoPDF() {
  const [state, setState] = useState({ status: 'idle', doc: null, error: null, progress: 0 });
  const cancelled = useRef(false);

  const load = useCallback(async (file, { pageIndex = 0, targetMetersPerPixel = 0.15 } = {}) => {
    cancelled.current = false;
    setState({ status: 'parsing', doc: null, error: null, progress: 0.05 });
    try {
      const buffer = await file.arrayBuffer();
      const { PDFDocument, pdfjs } = await loadPdfLibs();

      // --- langkah 2: georeferensi ---
      const meta = await parseGeoPDF(buffer, { PDFDocument }, pageIndex);
      if (!meta.georeferenced) {
        throw new Error(
          'Berkas ini PDF biasa, bukan GeoPDF: tidak ada kamus /Measure /GEO ' +
          'maupun LGIDict TerraGo. Ekspor ulang dari ArcGIS/QGIS dengan opsi ' +
          '"Export georeference information" aktif.'
        );
      }
      const viewport = meta.viewports[0];
      const georef = buildGeoref(viewport);

      setState((s) => ({ ...s, status: 'rendering', progress: 0.25 }));

      // --- langkah 4-5: rasterisasi ---
      const scale = chooseRenderScale(meta.pageSize, {
        targetMetersPerPixel,
        metersPerPoint: georef.metersPerPoint,
      });
      // ArrayBuffer akan ter-detach oleh pdf.js; berikan salinan agar pdf-lib
      // masih bisa dipakai bila pengguna berpindah halaman.
      const task = pdfjs.getDocument({ data: buffer.slice(0) });
      const pdf = await task.promise;
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      if (cancelled.current) return null;

      const pageBox = [0, 0, meta.pageSize.width, meta.pageSize.height];
      const doc = {
        meta,
        viewport,
        georef,
        canvas,
        scale,
        userToCanvas: userToCanvasMatrix(pageBox, scale),
        crsToCanvas: crsToCanvasMatrix(georef, pageBox, scale),
        bounds: georefBounds(georef, viewport.bbox),
        quality: {
          rmse: georef.fitQuality?.rmse ?? null,
          convergenceDeg: georef.convergenceDeg,
          metersPerPixel: georef.metersPerPoint ? georef.metersPerPoint / scale : null,
          megapixels: (canvas.width * canvas.height) / 1e6,
        },
      };
      setState({ status: 'ready', doc, error: null, progress: 1 });
      return doc;
    } catch (err) {
      setState({ status: 'error', doc: null, error: err.message, progress: 0 });
      return null;
    }
  }, []);

  useEffect(() => () => { cancelled.current = true; }, []);
  return { ...state, load };
}

/**
 * Komponen lapisan. Sengaja tidak memakai createLayerComponent dari
 * @react-leaflet/core karena GridLayer kustom kita punya siklus hidup sendiri
 * (kanvas sumber bisa diganti tanpa membuat ulang lapisan).
 */
export function GeoPDFLayer({ doc, opacity = 1, visible = true, fitOnLoad = true }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!doc || !map) return undefined;

    const GeoPDFGridLayer = createGeoPDFGridLayer(L);
    const layer = new GeoPDFGridLayer({
      sourceCanvas: doc.canvas,
      georef: doc.georef,
      crsToCanvas: doc.crsToCanvas,
      userToCanvas: doc.userToCanvas,
      userBBox: doc.viewport.bbox,
      opacity,
      // Batasi permintaan ubin ke luar cakupan lembar.
      bounds: L.latLngBounds(doc.bounds),
      pane: 'overlayPane',
    });
    layer.addTo(map);
    layerRef.current = layer;

    if (fitOnLoad) map.fitBounds(L.latLngBounds(doc.bounds), { padding: [16, 16] });

    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
    };
  }, [doc, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // Transparansi diubah tanpa membangun ulang lapisan.
  useEffect(() => {
    layerRef.current?.setOpacityValue?.(opacity);
  }, [opacity]);

  useEffect(() => {
    const l = layerRef.current;
    if (!l) return;
    l.getContainer()?.style.setProperty('display', visible ? '' : 'none');
  }, [visible]);

  return null;
}

/**
 * Panel mutu georeferensi.
 * Angka-angka ini bukan hiasan: pada aplikasi uji akurasi, pengguna berhak tahu
 * berapa besar galat yang disumbangkan oleh petanya sendiri sebelum menyalahkan
 * klasifikasi.
 */
export function GeoPDFQualityPanel({ doc, t, nf }) {
  if (!doc) return null;
  const q = doc.quality;
  const suspicious = doc.georef.fitQuality?.suspicious;

  return (
    <dl className="gt-quality">
      <div>
        <dt>{t('geopdf.crs')}</dt>
        <dd>
          {doc.viewport.crs.kind === 'utm'
            ? `UTM ${doc.viewport.crs.zone}${doc.viewport.crs.south ? 'S' : 'N'} (WGS 84)`
            : doc.viewport.crs.kind}
        </dd>
      </div>
      <div>
        <dt>{t('geopdf.fitRmse')}</dt>
        <dd className={suspicious ? 'is-warning mono' : 'mono'}>
          {q.rmse === null ? '—' : `${nf(q.rmse, 2)} m`}
        </dd>
      </div>
      <div>
        <dt>{t('geopdf.convergence')}</dt>
        <dd className="mono">{nf(q.convergenceDeg, 3)}&deg;</dd>
      </div>
      <div>
        <dt>{t('geopdf.groundRes')}</dt>
        <dd className="mono">{q.metersPerPixel ? `${nf(q.metersPerPixel, 3)} m/px` : '—'}</dd>
      </div>
      <div>
        <dt>{t('geopdf.canvasSize')}</dt>
        <dd className="mono">{nf(q.megapixels, 1)} MP</dd>
      </div>
      {suspicious && (
        <p className="gt-gps-alert">{t('geopdf.rmseWarn', { rmse: nf(q.rmse, 2) })}</p>
      )}
    </dl>
  );
}
