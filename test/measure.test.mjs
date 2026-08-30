/**
 * test/measure.test.mjs — pengukuran jarak dan luas.
 *
 * Seluruh nilai rujukan berasal dari pyproj.Geod pada elipsoid WGS84, bukan
 * dari perhitungan tangan maupun dari implementasi ini sendiri. Menguji kode
 * terhadap keluarannya sendiri hanya membuktikan ia konsisten, bukan benar.
 */
import assert from 'node:assert/strict';
import {
  vincentyDistance, pathLength, polygonArea, bearing,
  formatDistance, formatArea, R_AUTHALIC,
} from '../src/core/geo/measure.js';
import {
  shouldAccept, trackStats, trackToGeoJSON, trackToKML, TRACK_DEFAULTS,
} from '../src/core/track/track.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

console.log('\n== jarak geodesik ==');
// Rujukan pyproj Geod(ellps='WGS84').inv()
const KASUS = [
  ['jarak pendek skala lapangan (63 m)',
    -6.874468, 107.562790, -6.875000, 107.563000, 63.2467, 0.001],
  ['jarak menengah Bandung-Jakarta (118 km)',
    -6.9, 107.6, -6.2, 106.8, 117562.3967, 0.01],
  ['sepanjang khatulistiwa, 1 derajat bujur',
    0.0, 100.0, 0.0, 101.0, 111319.4908, 0.01],
  ['jarak benua Bandung-London (11.830 km)',
    -6.9, 107.6, 51.5, -0.12, 11830206.3300, 0.5],
  ['lintas kepulauan Bali-Jakarta (963 km)',
    -8.65, 115.22, -6.2, 106.85, 962807.6800, 0.05],
];
for (const [nama, la1, lo1, la2, lo2, ref, tol] of KASUS) {
  t(`${nama} cocok pyproj`, () => {
    const d = vincentyDistance(la1, lo1, la2, lo2);
    assert.ok(Math.abs(d - ref) <= tol,
      `${d.toFixed(4)} vs rujukan ${ref} (toleransi ${tol} m)`);
  });
}

t('haversine akan meleset jauh — inilah alasan Vincenty dipakai', () => {
  const R = 6371008.8;
  const rad = (x) => (x * Math.PI) / 180;
  const hav = (la1, lo1, la2, lo2) => {
    const dp = rad(la2 - la1), dl = rad(lo2 - lo1);
    const a = Math.sin(dp / 2) ** 2 +
      Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const ref = 111319.4908;
  const galatHav = Math.abs(hav(0, 100, 0, 101) - ref);
  const galatVin = Math.abs(vincentyDistance(0, 100, 0, 101) - ref);
  assert.ok(galatHav > 100, `haversine hanya meleset ${galatHav.toFixed(1)} m`);
  assert.ok(galatVin < 0.01, `vincenty meleset ${galatVin.toFixed(4)} m`);
  console.log(`       (pada 1 derajat khatulistiwa: haversine meleset ` +
    `${galatHav.toFixed(0)} m, Vincenty ${(galatVin * 1000).toFixed(2)} mm)`);
});

t('titik berimpit menghasilkan nol, bukan NaN', () => {
  assert.equal(vincentyDistance(-6.9, 107.6, -6.9, 107.6), 0);
});
t('jarak simetris ke dua arah', () => {
  const a = vincentyDistance(-6.9, 107.6, -6.2, 106.8);
  const b = vincentyDistance(-6.2, 106.8, -6.9, 107.6);
  assert.ok(Math.abs(a - b) < 1e-6);
});

console.log('\n== panjang jalur ==');
t('panjang jalur adalah jumlah ruasnya', () => {
  const pts = [
    { lat: -6.8745, lon: 107.5628 },
    { lat: -6.8750, lon: 107.5630 },
    { lat: -6.8755, lon: 107.5635 },
  ];
  const { total, segments } = pathLength(pts);
  assert.equal(segments.length, 2);
  assert.ok(Math.abs(total - (segments[0] + segments[1])) < 1e-9);
  assert.ok(total > 100 && total < 200, `${total} m di luar dugaan`);
});
t('jalur dengan kurang dari dua titik berpanjang nol', () => {
  assert.equal(pathLength([]).total, 0);
  assert.equal(pathLength([{ lat: 0, lon: 0 }]).total, 0);
});

console.log('\n== luas poligon ==');
// Rujukan pyproj Geod.polygon_area_perimeter()
const POLI = [
  ['petak kecil skala lapangan (3,08 ha)',
    [[107.5618, -6.8778], [107.5625, -6.8778], [107.5625, -6.8742], [107.5618, -6.8742]],
    30801.6715, 0.001],
  ['petak 11 km (12.221 ha)',
    [[107.0, -7.0], [107.1, -7.0], [107.1, -6.9], [107.0, -6.9]],
    122210236.583, 0.001],
  ['satu derajat di khatulistiwa',
    [[100, 0], [101, 0], [101, 1], [100, 1]],
    12308778361.47, 0.002],
];
for (const [nama, ring, ref, tolRel] of POLI) {
  t(`${nama} cocok pyproj`, () => {
    const a = polygonArea(ring.map(([lon, lat]) => ({ lat, lon })));
    const rel = Math.abs(a - ref) / ref;
    assert.ok(rel <= tolRel,
      `${a.toFixed(2)} vs ${ref} — galat relatif ${(rel * 100).toFixed(4)}%`);
    console.log(`       (galat relatif ${(rel * 100).toFixed(4)}%)`);
  });
}
t('arah putaran cincin tidak mengubah luas', () => {
  const ring = [{ lat: -6.8778, lon: 107.5618 }, { lat: -6.8778, lon: 107.5625 },
                { lat: -6.8742, lon: 107.5625 }, { lat: -6.8742, lon: 107.5618 }];
  const a = polygonArea(ring);
  const b = polygonArea([...ring].reverse());
  assert.ok(Math.abs(a - b) / a < 1e-9);
});
t('kurang dari tiga titik berluas nol', () => {
  assert.equal(polygonArea([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]), 0);
});
t('jari-jari autalik sesuai nilai baku WGS 84', () => {
  assert.ok(Math.abs(R_AUTHALIC - 6371007.181) < 0.001);
});

console.log('\n== azimut ==');
t('arah utara, timur, selatan, barat', () => {
  assert.ok(Math.abs(bearing(0, 100, 1, 100) - 0) < 0.01, 'utara');
  assert.ok(Math.abs(bearing(0, 100, 0, 101) - 90) < 0.01, 'timur');
  assert.ok(Math.abs(bearing(0, 100, -1, 100) - 180) < 0.01, 'selatan');
  assert.ok(Math.abs(bearing(0, 100, 0, 99) - 270) < 0.01, 'barat');
});

console.log('\n== penyajian angka ==');
t('satuan berpindah sesuai besarannya', () => {
  assert.match(formatDistance(0.42), /cm$/);
  assert.match(formatDistance(63.2), /m$/);
  assert.match(formatDistance(1234), /km$/);
});
t('luas memakai hektar, satuan kerja di lapangan', () => {
  assert.match(formatArea(30801), /ha$/);
  assert.match(formatArea(150), /m²$/);
  assert.match(formatArea(2.5e6), /km²/);
});
t('desimal tidak berlebihan pada jarak besar', () => {
  // Menampilkan milimeter pada jarak 1 km adalah ketelitian palsu.
  const s = formatDistance(1234.5678, 'en');
  assert.equal((s.match(/\d/g) ?? []).length <= 8, true, s);
});
t('nilai tidak sah ditampilkan sebagai strip', () => {
  assert.equal(formatDistance(NaN), '—');
  assert.equal(formatArea(undefined), '—');
});

console.log('\n== penyaringan jejak GPS ==');
const P = (lat, lon, t, acc = 5) => ({ lat, lon, t, accuracy: acc });

t('fix pertama selalu diterima', () => {
  assert.equal(shouldAccept(P(-6.87, 107.56, 0), null).accept, true);
});
t('fix dengan akurasi buruk ditolak', () => {
  const r = shouldAccept(P(-6.87, 107.56, 0, 60), null);
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'accuracy');
});
t('berdiri diam tidak menghasilkan titik baru', () => {
  // Inilah kasus yang paling merusak: derau GPS beberapa meter, berulang
  // ratusan kali, membuat jejak tampak berjalan padahal orangnya diam.
  const last = P(-6.87, 107.56, 0);
  const jitter = P(-6.870005, 107.560005, 5000);   // ~0.7 m
  const r = shouldAccept(jitter, last);
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'stationary');
});
t('perpindahan nyata diterima', () => {
  // ~11 m ke utara
  const r = shouldAccept(P(-6.8699, 107.56, 5000), P(-6.87, 107.56, 0));
  assert.equal(r.accept, true);
  assert.ok(r.distance > 5 && r.distance < 20, `${r.distance} m`);
});
t('fix terlalu rapat waktunya ditolak walau jaraknya cukup', () => {
  const r = shouldAccept(P(-6.8699, 107.56, 500), P(-6.87, 107.56, 0));
  assert.equal(r.reason, 'interval');
});
t('lompatan mustahil ditolak sebagai fix liar', () => {
  // 5 km dalam 3 detik = 6000 km/jam
  const r = shouldAccept(P(-6.92, 107.56, 3000), P(-6.87, 107.56, 0));
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'jump');
});
t('koordinat tidak sah ditolak, bukan merusak jejak', () => {
  assert.equal(shouldAccept({ lat: NaN, lon: 107, t: 0 }, null).accept, false);
  assert.equal(shouldAccept(null, null).accept, false);
});
t('ambang bawaan masuk akal untuk survei berjalan kaki', () => {
  assert.ok(TRACK_DEFAULTS.minDistance >= 3 && TRACK_DEFAULTS.minDistance <= 10);
  assert.ok(TRACK_DEFAULTS.maxAccuracy <= 30);
});

console.log('\n== ringkasan jejak ==');
const JEJAK = {
  name: 'Blok A',
  points: [
    P(-6.8745, 107.5628, 1000),
    P(-6.8750, 107.5630, 21000),
    P(-6.8755, 107.5635, 41000),
  ],
};
t('panjang, durasi, dan kecepatan dihitung konsisten', () => {
  const s = trackStats(JEJAK.points);
  assert.equal(s.points, 3);
  assert.equal(s.durationMs, 40000);
  assert.ok(Math.abs(s.avgSpeed - s.length / 40) < 1e-9, 'kecepatan tidak konsisten');
  assert.ok(s.length > 100 && s.length < 200, `${s.length} m`);
});
t('jejak satu titik tidak menghasilkan pembagian nol', () => {
  const s = trackStats([P(-6.87, 107.56, 0)]);
  assert.equal(s.length, 0);
  assert.equal(s.avgSpeed, 0);
});

console.log('\n== ekspor jejak ==');
t('GeoJSON berupa LineString dengan urutan lon,lat', () => {
  const g = trackToGeoJSON(JEJAK);
  const f = g.features[0];
  assert.equal(f.geometry.type, 'LineString');
  assert.equal(f.geometry.coordinates.length, 3);
  assert.ok(Math.abs(f.geometry.coordinates[0][0] - 107.5628) < 1e-9, 'bujur harus dahulu');
  assert.ok(f.properties.panjang_m > 0);
  assert.equal(f.properties.jumlah_titik, 3);
});
t('KML sah dan memakai clampToGround', () => {
  const k = trackToKML(JEJAK);
  assert.match(k, /<LineString>/);
  assert.match(k, /clampToGround/);
  const n = (k.match(/,0/g) ?? []).length;
  assert.ok(n >= 3, 'koordinat kurang');
});
t('karakter khusus pada nama jejak dilolosi', () => {
  const k = trackToKML({ name: 'Blok <A> & B', points: JEJAK.points });
  assert.ok(k.includes('Blok &lt;A&gt; &amp; B'));
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
