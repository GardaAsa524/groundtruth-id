/**
 * core/track/track.js
 * ---------------------------------------------------------------------------
 * Perekaman jejak perjalanan dari aliran fix GPS.
 *
 * MASALAH SEBENARNYA BUKAN MEREKAM, MELAINKAN MENYARING
 * -----------------------------------------------------
 * Geolocation API memberi fix setiap satu sampai dua detik. Merekam semuanya
 * apa adanya menimbulkan tiga masalah sekaligus:
 *
 * 1. Berdiri diam selama sepuluh menit menghasilkan ratusan titik yang
 *    seluruhnya menggambarkan tempat yang sama — dan karena setiap fix
 *    bergeser beberapa meter secara acak, hasilnya bukan satu titik melainkan
 *    gumpalan kusut. Panjang jejak ikut membengkak oleh derau itu: berdiri
 *    diam sepuluh menit dapat tercatat sebagai berjalan ratusan meter.
 * 2. Berkas jejak membesar tanpa menambah informasi apa pun.
 * 3. Menggambar ulang polyline berisi ribuan titik membuat peta tersendat di
 *    ponsel kelas menengah.
 *
 * Karena itu fix disaring sebelum diterima. Aturannya sengaja sederhana dan
 * dapat dijelaskan kepada pengguna, bukan penapis Kalman yang perilakunya
 * tidak dapat ditebak di lapangan.
 */

import { vincentyDistance, pathLength } from '../geo/measure.js';

export const TRACK_DEFAULTS = {
  /** Fix lebih buruk dari ini diabaikan seluruhnya. */
  maxAccuracy: 25,
  /** Jarak minimum dari titik terakhir sebelum fix baru diterima. */
  minDistance: 5,
  /** Jeda minimum antartitik, mencegah banjir titik saat bergerak cepat. */
  minIntervalMs: 2000,
  /**
   * Lompatan yang lebih jauh dari ini dalam satu langkah dianggap fix liar.
   * 200 m dalam dua detik setara 360 km/jam — mustahil untuk survei berjalan
   * kaki maupun berkendara di jalan biasa.
   */
  maxJump: 200,
};

/**
 * Putuskan apakah satu fix layak masuk jejak.
 *
 * Dipisahkan sebagai fungsi murni supaya seluruh aturannya dapat diuji tanpa
 * GPS, tanpa peramban, dan tanpa menunggu waktu nyata berjalan.
 *
 * @returns {{accept:boolean, reason?:string, distance?:number}}
 */
export function shouldAccept(fix, last, opt = {}) {
  const o = { ...TRACK_DEFAULTS, ...opt };

  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lon)) {
    return { accept: false, reason: 'invalid' };
  }
  if (Number.isFinite(fix.accuracy) && fix.accuracy > o.maxAccuracy) {
    return { accept: false, reason: 'accuracy' };
  }
  if (!last) return { accept: true, reason: 'first' };

  const dt = (fix.t ?? 0) - (last.t ?? 0);
  if (dt < o.minIntervalMs) return { accept: false, reason: 'interval' };

  const d = vincentyDistance(last.lat, last.lon, fix.lat, fix.lon);

  if (d > o.maxJump) return { accept: false, reason: 'jump', distance: d };
  if (d < o.minDistance) return { accept: false, reason: 'stationary', distance: d };

  return { accept: true, distance: d };
}

/** Ringkasan jejak: panjang, durasi, dan kecepatan rata-rata. */
export function trackStats(points) {
  const n = points?.length ?? 0;
  if (n < 2) {
    return { points: n, length: 0, durationMs: 0, avgSpeed: 0, startedAt: points?.[0]?.t ?? null };
  }
  const { total } = pathLength(points);
  const durationMs = (points[n - 1].t ?? 0) - (points[0].t ?? 0);
  return {
    points: n,
    length: total,
    durationMs,
    // meter per detik; nol bila cap waktunya tidak masuk akal
    avgSpeed: durationMs > 0 ? total / (durationMs / 1000) : 0,
    startedAt: points[0].t,
    endedAt: points[n - 1].t,
  };
}

/** Jejak menjadi GeoJSON LineString. */
export function trackToGeoJSON(track) {
  const s = trackStats(track.points);
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: track.points.map((p) => [p.lon, p.lat]),
      },
      properties: {
        nama: track.name ?? 'Jejak',
        jumlah_titik: s.points,
        panjang_m: Number(s.length.toFixed(2)),
        durasi_detik: Math.round(s.durationMs / 1000),
        kecepatan_rata_ms: Number(s.avgSpeed.toFixed(3)),
        mulai: s.startedAt ? new Date(s.startedAt).toISOString() : '',
        selesai: s.endedAt ? new Date(s.endedAt).toISOString() : '',
      },
    }],
  };
}

/**
 * Jejak menjadi KML.
 *
 * altitudeMode clampToGround dipakai dengan sengaja: ketinggian dari GPS
 * ponsel jauh lebih buruk daripada posisi mendatarnya, lazim meleset puluhan
 * meter. Menggambar jejak pada ketinggian itu membuatnya melayang atau
 * tenggelam di Google Earth, yang terlihat seperti kesalahan data padahal
 * posisi mendatarnya benar.
 */
export function trackToKML(track) {
  const s = trackStats(track.points);
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const coords = track.points.map((p) => `${p.lon},${p.lat},0`).join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(track.name ?? 'Jejak REIS')}</name>
    <Style id="jejak">
      <LineStyle><color>ff882eff</color><width>4</width></LineStyle>
    </Style>
    <Placemark>
      <name>${esc(track.name ?? 'Jejak')}</name>
      <styleUrl>#jejak</styleUrl>
      <description>${esc(
        `${s.points} titik · ${(s.length / 1000).toFixed(3)} km · ` +
        `${Math.round(s.durationMs / 60000)} menit`)}</description>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}
