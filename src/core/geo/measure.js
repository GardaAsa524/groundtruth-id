/**
 * core/geo/measure.js
 * ---------------------------------------------------------------------------
 * Pengukuran jarak dan luas di atas elipsoid WGS 84.
 *
 * MENGAPA TIDAK MEMAKAI HAVERSINE
 * -------------------------------
 * Haversine mengandaikan bumi bulat sempurna. Galatnya sekitar 0,3 persen —
 * terdengar kecil, tetapi berarti 3 meter setiap kilometer. Untuk aplikasi
 * yang seluruh alasannya ada adalah menguji ketelitian, mengukur dengan alat
 * yang salah 3 meter per kilometer adalah kontradiksi.
 *
 * Rumus balik Vincenty di bawah bekerja pada elipsoid dan teliti sampai
 * kisaran milimeter. Ia iteratif dan sedikit lebih lambat, tetapi pengukuran
 * dilakukan pada belasan titik, bukan jutaan — biayanya tidak terasa.
 *
 * LUAS DIHITUNG BERBEDA, DAN ITU DISENGAJA
 * ----------------------------------------
 * Luas poligon di atas elipsoid tidak punya bentuk tertutup yang sederhana.
 * Pendekatan yang dipakai di sini adalah kelebihan bola (spherical excess)
 * pada bola berjari-jari autalik WGS 84 — bola yang luas permukaannya sama
 * persis dengan elipsoid. Untuk poligon berskala lapangan, galatnya jauh di
 * bawah satu per seribu, dan diuji langsung terhadap pyproj.Geod.
 */

const A = 6378137.0;                 // sumbu panjang WGS84
const F = 1 / 298.257223563;         // penggepengan
const B = A * (1 - F);               // sumbu pendek

/** Jari-jari autalik WGS 84: bola dengan luas permukaan setara elipsoid. */
export const R_AUTHALIC = 6371007.181;

const E2 = F * (2 - F);              // eksentrisitas kuadrat
const E = Math.sqrt(E2);

const rad = (d) => (d * Math.PI) / 180;

/**
 * Lintang autalik: lintang pada bola autalik yang memberi luas setara.
 *
 * INI BAGIAN YANG MUDAH TERLEWAT DAN MAHAL AKIBATNYA.
 * Rumus kelebihan bola menuntut lintang autalik, bukan lintang geodetik.
 * Memasukkan lintang geodetik apa adanya menghasilkan luas yang terlalu besar
 * sekitar 0,43 persen — dan galatnya SISTEMATIS, bukan acak: ia muncul dengan
 * besaran relatif yang sama pada petak 3 hektar maupun pada petak sejuta
 * hektar. Bias sebesar itu tidak akan pernah terlihat dari memeriksa hasil
 * sendiri; ia hanya ketahuan bila dibandingkan dengan pustaka geodesi yang
 * mandiri.
 *
 * Rumus q Snyder (1987), persamaan 3-12.
 */
function authalicLat(phi) {
  const sp = Math.sin(phi);
  const q = (1 - E2) * (
    sp / (1 - E2 * sp * sp) -
    (1 / (2 * E)) * Math.log((1 - E * sp) / (1 + E * sp))
  );
  // qp adalah nilai q pada kutub; rasionya memberi sin(lintang autalik).
  const qp = (1 - E2) * (
    1 / (1 - E2) - (1 / (2 * E)) * Math.log((1 - E) / (1 + E))
  );
  const ratio = q / qp;
  // Pembulatan float dapat mendorong rasio sedikit melewati 1 di kutub.
  return Math.asin(Math.max(-1, Math.min(1, ratio)));
}

/**
 * Jarak geodesik antara dua titik, rumus balik Vincenty.
 *
 * @returns {number} meter. NaN bila iterasi tidak konvergen (titik antipodal).
 */
export function vincentyDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const L = rad(lon2 - lon1);
  const U1 = Math.atan((1 - F) * Math.tan(rad(lat1)));
  const U2 = Math.atan((1 - F) * Math.tan(rad(lat2)));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaP;
  let iter = 0;
  let sinSigma, cosSigma, sigma, sinAlpha, cos2Alpha, cos2SigmaM, C;

  do {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 +
      (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
    );
    if (sinSigma === 0) return 0;                     // titik berimpit

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    // Pada garis khatulistiwa cos2Alpha = 0 dan cos2SigmaM tidak terdefinisi;
    // nilai 0 adalah penanganan baku dan menghasilkan hasil yang benar.
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma *
        (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && ++iter < 200);

  if (iter >= 200) return NaN;                        // hampir antipodal

  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const Acoef = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const Bcoef = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma = Bcoef * sinSigma *
    (cos2SigmaM + (Bcoef / 4) *
      (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
        (Bcoef / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
          (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return B * Acoef * (sigma - deltaSigma);
}

/**
 * Panjang jalur berurutan.
 * @param {Array<{lat:number,lon:number}>} pts
 * @returns {{total:number, segments:number[]}}
 */
export function pathLength(pts) {
  const segments = [];
  let total = 0;
  for (let i = 1; i < (pts?.length ?? 0); i++) {
    const d = vincentyDistance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    segments.push(d);
    total += d;
  }
  return { total, segments };
}

/**
 * Luas poligon dengan kelebihan bola pada bola autalik.
 *
 * Cincin dianggap tertutup secara implisit; titik terakhir tidak perlu sama
 * dengan titik pertama. Nilai mutlak dikembalikan, jadi arah putaran cincin
 * tidak berpengaruh.
 *
 * @returns {number} meter persegi
 */
export function polygonArea(pts) {
  const n = pts?.length ?? 0;
  if (n < 3) return 0;

  // Lintang diubah ke lintang autalik lebih dahulu — lihat catatan pada
  // authalicLat() untuk alasannya.
  const beta = pts.map((p) => Math.sin(authalicLat(rad(p.lat))));

  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += rad(pts[j].lon - pts[i].lon) * (2 + beta[i] + beta[j]);
  }
  return Math.abs((total * R_AUTHALIC * R_AUTHALIC) / 2);
}

/** Azimut awal dari titik 1 ke titik 2, derajat searah jarum jam dari utara. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/* ------------------------------------------------------------- penyajian */

/**
 * Format jarak dengan satuan dan ketelitian yang wajar.
 *
 * Menampilkan "1234.5678 m" adalah ketelitian palsu: GPS ponsel tidak pernah
 * sebaik itu, dan angka di belakang koma hanya membuat pembacanya keliru
 * mengira pengukurannya lebih pasti daripada yang sebenarnya.
 */
export function formatDistance(m, locale = 'id') {
  if (!Number.isFinite(m)) return '—';
  const nf = (v, d) => new Intl.NumberFormat(
    locale === 'id' ? 'id-ID' : 'en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);

  if (m < 1) return `${nf(m * 100, 0)} cm`;
  if (m < 1000) return `${nf(m, m < 10 ? 2 : 1)} m`;
  return `${nf(m / 1000, 3)} km`;
}

export function formatArea(m2, locale = 'id') {
  if (!Number.isFinite(m2)) return '—';
  const nf = (v, d) => new Intl.NumberFormat(
    locale === 'id' ? 'id-ID' : 'en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);

  if (m2 < 10000) return `${nf(m2, m2 < 100 ? 2 : 1)} m²`;
  // Hektar adalah satuan kerja di lapangan Indonesia, jadi ia yang
  // didahulukan sebelum kilometer persegi.
  if (m2 < 1e6) return `${nf(m2 / 10000, 4)} ha`;
  return `${nf(m2 / 1e6, 4)} km² (${nf(m2 / 10000, 1)} ha)`;
}
