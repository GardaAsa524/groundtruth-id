/**
 * core/geo/projection.js
 * ---------------------------------------------------------------------------
 * Lapisan proyeksi minimal untuk GroundTruth.id.
 *
 * Mengapa tidak langsung memakai proj4js?
 *   proj4js (~130 kB) tetap dipakai sebagai jalur umum di `resolveCRS()` untuk
 *   CRS yang tidak lazim. Namun 95% berkas lapangan di Indonesia memakai
 *   WGS 84 / UTM zona 46N-54S atau EPSG:4326. Untuk kedua kasus itu kita pakai
 *   implementasi deret Snyder di bawah: bebas dependensi, dapat dipanggil di
 *   dalam Web Worker tanpa memuat proj4 defs, dan cukup cepat untuk dipanggil
 *   ribuan kali per detik saat menggambar ulang layer GeoPDF.
 *
 * Ketelitian: deret orde-6 Snyder, galat < 1 mm dalam zona (|Δλ| < 3.5°).
 * Itu dua orde besaran lebih baik daripada ketelitian GPS ponsel (3-15 m),
 * sehingga bukan sumber galat yang perlu dikhawatirkan.
 */

const A = 6378137.0;                      // sumbu panjang WGS84
const F = 1 / 298.257223563;              // penggepengan
const K0 = 0.9996;                        // faktor skala UTM
const E2 = F * (2 - F);                   // eksentrisitas kuadrat
const EP2 = E2 / (1 - E2);                // eksentrisitas kedua kuadrat

const ZONE_LIMIT_DEG = 3.5;

/** Peringatan zona terakhir; dibaca lapisan UI untuk menampilkan catatan mutu. */
let lastZoneWarning = null;
export function consumeZoneWarning() {
  const w = lastZoneWarning;
  lastZoneWarning = null;
  return w;
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Meridian tengah zona UTM, dalam derajat. */
export function centralMeridian(zone) {
  return (zone - 1) * 6 - 180 + 3;
}

/** Zona UTM dari bujur. */
export function utmZoneFromLon(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

/**
 * WGS84 geografis -> UTM.
 * @param {number} lat derajat
 * @param {number} lon derajat
 * @param {{zone?:number, south?:boolean}} opt zona dieksplisitkan bila berkas
 *        memakai zona yang berbeda dari zona alami titiknya (lazim di tepi zona).
 * @returns {{x:number, y:number, zone:number, south:boolean}}
 */
export function forwardUTM(lat, lon, opt = {}) {
  const zone = opt.zone ?? utmZoneFromLon(lon);
  const south = opt.south ?? lat < 0;

  // Deret Snyder hanya sahih di dalam zona. Bila berkas memaksa zona yang
  // jauh dari titiknya — lazim pada mosaik lintas zona — ketelitian merosot
  // cepat: pada 10° dari meridian tengah, galat bolak-balik sudah ~5 cm dan
  // tumbuh dengan pangkat enam. Kita tandai, bukan diam-diam mengembalikan
  // angka yang salah.
  const dLon = Math.abs(lon - centralMeridian(zone));
  if (dLon > ZONE_LIMIT_DEG) {
    lastZoneWarning = {
      lon, zone, dLon,
      message:
        `Titik berjarak ${dLon.toFixed(1)}° dari meridian tengah zona ${zone}. ` +
        'Ketelitian deret menurun di luar ±3.5°; pertimbangkan proj4js untuk CRS ini.',
    };
  }
  const p = rad(lat);
  const l = rad(lon);
  const l0 = rad(centralMeridian(zone));

  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const tp = Math.tan(p);

  const N = A / Math.sqrt(1 - E2 * sp * sp);
  const T = tp * tp;
  const C = EP2 * cp * cp;
  const Aa = cp * (l - l0);

  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * p -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * p));

  const x =
    K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 +
      ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;

  let y =
    K0 * (M + N * tp * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 +
      ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));

  if (south) y += 10000000;
  return { x, y, zone, south };
}

/**
 * UTM -> WGS84 geografis (deret balik Snyder).
 * Diperlukan untuk menempatkan sudut GeoPDF (yang sering hanya menyimpan
 * koordinat terproyeksi) ke dalam ruang lintang-bujur Leaflet.
 */
export function inverseUTM(x, y, zone, south) {
  const yy = south ? y - 10000000 : y;
  const xx = x - 500000;

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = yy / K0;
  const mu =
    M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));

  const p1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sp = Math.sin(p1);
  const cp = Math.cos(p1);
  const tp = Math.tan(p1);

  const C1 = EP2 * cp * cp;
  const T1 = tp * tp;
  const N1 = A / Math.sqrt(1 - E2 * sp * sp);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sp * sp, 1.5);
  const D = xx / (N1 * K0);

  const lat =
    p1 -
    ((N1 * tp) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);

  const lon =
    rad(centralMeridian(zone)) +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / cp;

  return { lat: deg(lat), lon: deg(lon) };
}

/**
 * Konvergensi meridian (gisement) dalam derajat: sudut antara utara grid
 * (sumbu Y UTM) dan utara geografis pada titik tertentu.
 *
 * INI PENTING DAN SERING TERLEWAT.
 * Peta GeoPDF hasil ArcGIS/QGIS umumnya "utara grid" — sisi atas lembar sejajar
 * sumbu Y UTM, bukan meridian. Jika citranya ditempel sebagai L.imageOverlay
 * dengan kotak lintang-bujur biasa, seluruh peta akan terputar sebesar sudut ini.
 *
 * Contoh nyata dari lapangan (Bandung, 107.56°E, -6.88°):
 *   γ ≈ -0.31°  →  pada lembar setinggi 365 m, simpangan di sudut ≈ 1.7 m.
 * Nilai itu setara dengan separuh anggaran galat GPS ponsel dan akan mencemari
 * uji akurasi. Karena itu GeoPDFGridLayer melakukan resampling per ubin,
 * bukan penempelan gambar mentah.
 */
export function meridianConvergence(lat, lon, zone = utmZoneFromLon(lon)) {
  const dLon = rad(lon - centralMeridian(zone));
  const p = rad(lat);
  // deret orde-3; cukup untuk seluruh lebar zona
  const c = Math.cos(p);
  const t = Math.tan(p);
  const eta2 = EP2 * c * c;
  const g =
    dLon * Math.sin(p) +
    (dLon ** 3 / 3) * Math.sin(p) * c * c * (1 + 3 * eta2 + 2 * eta2 * eta2);
  return deg(g);
}

/* --------------------------------------------------------------------------
 * Pembacaan WKT sederhana.
 * GeoPDF menyimpan CRS sebagai string WKT di dalam /GCS. Kita hanya perlu
 * beberapa parameter untuk mengenali UTM; sisanya diserahkan ke proj4js.
 * -------------------------------------------------------------------------- */

/** Ambil satu PARAMETER dari WKT. */
function wktParam(wkt, name) {
  const re = new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+]+)`, 'i');
  const m = wkt.match(re);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Terjemahkan WKT GeoPDF menjadi deskriptor CRS yang bisa dipakai modul lain.
 * Mengembalikan { kind:'geographic' } | { kind:'utm', zone, south } |
 * { kind:'wkt', wkt } (jalur proj4js).
 */
export function describeCRS(gcs) {
  if (!gcs) return { kind: 'geographic' };
  if (typeof gcs === 'object' && gcs.epsg) return epsgToDescriptor(gcs.epsg);

  const wkt = String(gcs.wkt ?? gcs);
  if (/^GEOGCS/i.test(wkt.trim())) return { kind: 'geographic', wkt };

  const isTM = /Transverse_Mercator/i.test(wkt);
  const k0 = wktParam(wkt, 'Scale_Factor') ?? wktParam(wkt, 'scale_factor');
  const fe = wktParam(wkt, 'False_Easting') ?? wktParam(wkt, 'false_easting');
  const fn = wktParam(wkt, 'False_Northing') ?? wktParam(wkt, 'false_northing');
  const cm = wktParam(wkt, 'Central_Meridian') ?? wktParam(wkt, 'central_meridian');

  // UTM dikenali dari sidik jarinya: TM + k0 0.9996 + FE 500000 + CM kelipatan 6-3
  if (isTM && k0 !== null && Math.abs(k0 - 0.9996) < 1e-9 && fe === 500000 && cm !== null) {
    const zone = Math.round((cm + 183) / 6);
    const south = fn === 10000000;
    return { kind: 'utm', zone, south, wkt };
  }
  return { kind: 'wkt', wkt };
}

export function epsgToDescriptor(code) {
  const n = Number(code);
  if (n === 4326) return { kind: 'geographic', epsg: 4326 };
  if (n >= 32601 && n <= 32660) return { kind: 'utm', zone: n - 32600, south: false, epsg: n };
  if (n >= 32701 && n <= 32760) return { kind: 'utm', zone: n - 32700, south: true, epsg: n };
  return { kind: 'epsg', epsg: n };
}

/**
 * Pembuat pasangan fungsi maju/balik untuk deskriptor CRS.
 * `proj4` opsional; hanya diperlukan untuk kind 'wkt' / 'epsg' non-UTM.
 */
export function makeTransformer(descriptor, proj4 = null) {
  if (descriptor.kind === 'geographic') {
    return {
      toCRS: (lat, lon) => ({ x: lon, y: lat }),
      toWGS84: (x, y) => ({ lat: y, lon: x }),
    };
  }
  if (descriptor.kind === 'utm') {
    const { zone, south } = descriptor;
    return {
      toCRS: (lat, lon) => forwardUTM(lat, lon, { zone, south }),
      toWGS84: (x, y) => inverseUTM(x, y, zone, south),
    };
  }
  if (!proj4) {
    throw new Error(
      `CRS "${descriptor.epsg ?? 'WKT'}" memerlukan proj4js. ` +
        'Muat modul opsional proj4 lalu teruskan sebagai argumen kedua.'
    );
  }
  const def = descriptor.wkt ?? `EPSG:${descriptor.epsg}`;
  const fwd = proj4('EPSG:4326', def);
  return {
    toCRS: (lat, lon) => {
      const [x, y] = fwd.forward([lon, lat]);
      return { x, y };
    },
    toWGS84: (x, y) => {
      const [lon, lat] = fwd.inverse([x, y]);
      return { lat, lon };
    },
  };
}
