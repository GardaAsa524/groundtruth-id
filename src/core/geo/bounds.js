/**
 * core/geo/bounds.js
 * ---------------------------------------------------------------------------
 * Reproyeksi kotak pembatas raster menjadi batas lintang-bujur Leaflet.
 *
 * MENGAPA INI MODUL TERSENDIRI DAN BUKAN BEBERAPA BARIS DI DALAM KOMPONEN
 * ----------------------------------------------------------------------
 * Kesalahan yang ditangani di sini adalah kegagalan senyap yang paling mahal
 * di aplikasi raster berbasis peramban:
 *
 *   GeoTIFF lapangan di Indonesia hampir selalu UTM 48S/49S, bukan EPSG:4326.
 *   Memakai bbox terproyeksi apa adanya berarti memberi Leaflet koordinat
 *   seperti (9239000, 783000) sebagai derajat. Leaflet tidak mengeluh; ia
 *   hanya menampilkan layar kosong. Pengembang kemudian menghabiskan sore hari
 *   memeriksa shader, padahal masalahnya di baris bounds.
 *
 * Karena logikanya murni, ia diuji langsung di Node — tidak perlu jsdom
 * maupun konteks WebGL.
 */

import { epsgToDescriptor, makeTransformer, meridianConvergence } from './projection.js';

/**
 * @param {number[]} bbox [minX, minY, maxX, maxY] dalam satuan CRS berkas
 * @param {number|null} epsg kode EPSG dari geoKeys GeoTIFF
 * @param {{samples?:number, proj4?:any}} opt
 * @returns {{bounds:number[][]|null, reprojected:boolean, descriptor:object, error?:string}}
 */
export function bboxToLatLngBounds(bbox, epsg, opt = {}) {
  const { samples = 12, proj4 = null } = opt;
  const [minX, minY, maxX, maxY] = bbox;

  const descriptor = epsg ? epsgToDescriptor(Number(epsg)) : { kind: 'geographic' };

  if (descriptor.kind === 'geographic') {
    // Pemeriksaan kewarasan: bila "derajat" berada di luar rentang yang sah,
    // berkasnya hampir pasti terproyeksi tetapi tidak memuat kode EPSG.
    const plausible =
      Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 &&
      Math.abs(minY) <= 90 && Math.abs(maxY) <= 90;
    if (!plausible) {
      return {
        bounds: null,
        reprojected: false,
        descriptor,
        error:
          'Bbox berada di luar rentang lintang-bujur yang sah, tetapi berkas tidak ' +
          'menyertakan kode EPSG. Kemungkinan besar GeoTIFF ini terproyeksi tanpa ' +
          'GeoKey yang lengkap — tetapkan CRS-nya secara manual.',
      };
    }
    return { bounds: [[minY, minX], [maxY, maxX]], reprojected: false, descriptor };
  }

  let tf;
  try {
    tf = makeTransformer(descriptor, proj4);
  } catch (e) {
    // CRS yang memerlukan proj4js dan belum dimuat. Menolak dengan jelas lebih
    // baik daripada menempatkan citra di koordinat yang tidak masuk akal.
    return { bounds: null, reprojected: false, descriptor, error: e.message };
  }

  // Tepi kotak UTM melengkung ringan dalam ruang lintang-bujur, jadi kita
  // mencuplik sepanjang keempat sisi, bukan hanya sudutnya. Pada cakupan satu
  // tile Sentinel-2 (110 km) selisih antara "hanya sudut" dan "tepi tercuplik"
  // mencapai belasan meter di tengah sisi.
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  let valid = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const edge = [
      [minX + t * (maxX - minX), minY],
      [minX + t * (maxX - minX), maxY],
      [minX, minY + t * (maxY - minY)],
      [maxX, minY + t * (maxY - minY)],
    ];
    for (const [x, y] of edge) {
      const { lat, lon } = tf.toWGS84(x, y);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      valid++;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (!valid || minLat > maxLat) {
    return {
      bounds: null, reprojected: false, descriptor,
      error: 'Reproyeksi bbox tidak menghasilkan koordinat yang sah.',
    };
  }

  return { bounds: [[minLat, minLon], [maxLat, maxLon]], reprojected: true, descriptor };
}

/**
 * Perkiraan simpangan akibat menempelkan citra terproyeksi ke kotak
 * lintang-bujur (yang dilakukan L.imageOverlay).
 *
 * Ini kompromi sadar: untuk citra kecil, simpangannya di bawah satu piksel dan
 * imageOverlay jauh lebih sederhana daripada GridLayer. Untuk cakupan puluhan
 * kilometer, simpangannya menjadi puluhan meter — dan pada aplikasi uji
 * akurasi, angka itu harus ditampilkan, bukan disembunyikan.
 */
export function estimateOverlaySkew(bounds, descriptor) {
  if (!bounds || descriptor?.kind !== 'utm') {
    return { convergenceDeg: 0, skewMeters: 0, warn: false };
  }
  const midLat = (bounds[0][0] + bounds[1][0]) / 2;
  const midLon = (bounds[0][1] + bounds[1][1]) / 2;
  const convergenceDeg = meridianConvergence(midLat, midLon, descriptor.zone);
  const heightM = (bounds[1][0] - bounds[0][0]) * 110540;
  const skewMeters = Math.abs(Math.tan((convergenceDeg * Math.PI) / 180)) * (heightM / 2);
  return {
    convergenceDeg,
    skewMeters,
    // Ambang 5 m: kira-kira separuh anggaran galat GPS ponsel yang baik.
    // Di bawah itu, penempelan sederhana tidak menjadi sumber galat dominan.
    warn: skewMeters > 5,
  };
}
