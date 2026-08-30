/**
 * core/geopdf/georefModel.js
 * ---------------------------------------------------------------------------
 * Mengubah hasil parser menjadi rantai transformasi yang siap dipakai.
 *
 * RANTAI LENGKAP DARI GPS SAMPAI PIKSEL LAYAR
 * -------------------------------------------
 *   [1] Geolocation API      lat/lon WGS84
 *   [2] toCRS()              koordinat terproyeksi peta (mis. UTM 48S, meter)
 *   [3] crsToUser (affine)   ruang pengguna PDF (titik, origin kiri-bawah)
 *   [4] userToCanvas         piksel kanvas hasil render pdf.js (origin kiri-atas)
 *   [5] Leaflet              piksel layar
 *
 * Langkah 2 dan 3 dihitung sekali saat berkas dimuat. Langkah 4 bergantung
 * pada DPI render. Langkah 5 ditangani GeoPDFGridLayer per ubin.
 *
 * Arah balik (layar -> lat/lon) dipakai saat pengguna mengetuk peta untuk
 * menempatkan titik observasi, jadi setiap matriks disimpan bersama inversnya.
 */

import { fitAffine, apply, invert, compose, scaleOf, rotationOf } from '../geo/affine.js';
import { makeTransformer, meridianConvergence } from '../geo/projection.js';

/**
 * @param {import('./parseGeoPDF.js').GeoPDFViewport} viewport
 * @param {{proj4?:any}} opt
 */
export function buildGeoref(viewport, opt = {}) {
  const crs = viewport.crs;
  const tf = makeTransformer(crs, opt.proj4 ?? null);

  const [x0, y0, x1, y1] = viewport.bbox;
  const bboxW = x1 - x0;
  const bboxH = y1 - y0;

  let userToCRS;
  let fitQuality = null;

  if (viewport.encoding === 'terrago' && viewport.ctm) {
    // TerraGo sudah memberi matriksnya langsung.
    userToCRS = viewport.ctm;
  } else {
    // OGC: bangun korespondensi titik.
    // LPTS ternormalisasi terhadap BBox: (0,0) = kiri-bawah BBox.
    const src = viewport.lpts.map((p) => ({
      x: x0 + p.u * bboxW,
      y: y0 + p.v * bboxH,
    }));
    const dst = viewport.gpts.map((g) => {
      const { x, y } = tf.toCRS(g.lat, g.lon);
      return { x, y };
    });

    const fit = fitAffine(src, dst);
    userToCRS = fit.matrix;
    fitQuality = {
      rmse: fit.rmse,
      residuals: fit.residuals,
      // Pembulatan GPTS ke 5 desimal setara ~1.1 m; RMSE di atas itu menandakan
      // berkas cacat atau bukan proyeksi yang kita kira.
      suspicious: fit.rmse > 3,
    };
  }

  const crsToUser = invert(userToCRS);

  // Konvergensi meridian di tengah lembar — dipakai untuk memutuskan apakah
  // penempelan sederhana (imageOverlay) masih dapat diterima.
  let convergenceDeg = 0;
  let center = null;
  if (viewport.gpts?.length) {
    const lat = viewport.gpts.reduce((a, g) => a + g.lat, 0) / viewport.gpts.length;
    const lon = viewport.gpts.reduce((a, g) => a + g.lon, 0) / viewport.gpts.length;
    center = { lat, lon };
    if (crs.kind === 'utm') convergenceDeg = meridianConvergence(lat, lon, crs.zone);
  }

  return {
    crs,
    bbox: viewport.bbox,
    userToCRS,
    crsToUser,
    fitQuality,
    convergenceDeg,
    center,

    /** meter per titik PDF — dipakai memilih DPI render yang cukup */
    metersPerPoint: crs.kind === 'geographic' ? null : scaleOf(userToCRS),
    rotationDeg: rotationOf(userToCRS),

    /** lat/lon -> ruang pengguna PDF */
    lonLatToUser(lat, lon) {
      const p = tf.toCRS(lat, lon);
      return apply(crsToUser, p.x, p.y);
    },
    /** ruang pengguna PDF -> lat/lon */
    userToLonLat(ux, uy) {
      const p = apply(userToCRS, ux, uy);
      return tf.toWGS84(p.x, p.y);
    },
    toCRS: tf.toCRS,
    toWGS84: tf.toWGS84,
  };
}

/**
 * Matriks dari ruang pengguna PDF ke piksel kanvas hasil render.
 *
 * pdf.js merender dengan origin kiri-atas dan sumbu Y ke bawah, sedangkan
 * ruang pengguna PDF beroigin kiri-bawah dengan Y ke atas. Pembalikan itu
 * sering menjadi sumber peta yang tampil terbalik secara vertikal.
 *
 * @param {number[]} pageBox [0,0,w,h] ukuran halaman dalam titik
 * @param {number} scale     faktor render pdf.js (1 = 72 dpi)
 */
export function userToCanvasMatrix(pageBox, scale) {
  const pageH = pageBox[3] - pageBox[1];
  return {
    a: scale, b: 0,
    c: 0, d: -scale,
    e: -pageBox[0] * scale,
    f: (pageBox[1] + pageH) * scale,
  };
}

/**
 * Gabungan siap pakai: koordinat terproyeksi -> piksel kanvas.
 * Inilah matriks yang diserahkan ke GeoPDFGridLayer.
 */
export function crsToCanvasMatrix(georef, pageBox, scale) {
  return compose(userToCanvasMatrix(pageBox, scale), georef.crsToUser);
}

/**
 * Pilih skala render pdf.js agar satu piksel kanvas kira-kira sepadan dengan
 * satu piksel layar pada zoom maksimum yang diinginkan.
 *
 * Merender pada skala berlebihan adalah cara tercepat menghabiskan memori
 * peramban: kanvas 8000x8000 = 256 MB pada RGBA, dan Safari iOS akan
 * membuang kanvas tersebut secara diam-diam. Karena itu kita membatasi
 * total piksel, bukan sekadar DPI.
 */
export function chooseRenderScale(pageSize, {
  targetMetersPerPixel = 0.15,
  metersPerPoint = null,
  maxPixels = 24e6,           // ~24 MP ≈ 96 MB RGBA, aman di ponsel kelas menengah
  maxScale = 8,
} = {}) {
  let scale = 2;
  if (metersPerPoint) scale = metersPerPoint / targetMetersPerPixel;
  scale = Math.min(scale, maxScale);

  const px = pageSize.width * pageSize.height * scale * scale;
  if (px > maxPixels) scale *= Math.sqrt(maxPixels / px);
  return Math.max(0.5, scale);
}
