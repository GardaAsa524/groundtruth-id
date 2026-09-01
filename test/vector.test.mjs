/**
 * test/vector.test.mjs — pembaca KML dan perhitungan luas.
 *
 * Nilai rujukan luas berasal dari pyproj.Geod pada elipsoid WGS84.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseKML, parseCoordinates } from '../src/core/vector/kml.js';
import { featureArea, areaByClass } from '../src/core/vector/area.js';
import { isClassHidden, styleFor } from '../src/core/vector/style.js';

const { DOMParser } = new JSDOM().window;
const parse = (t) => parseKML(t, { DOMParser });

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const near = (a, b, tol, m) =>
  assert.ok(Math.abs(a - b) <= tol, `${m ?? ''} — ${a} vs ${b} (tol ${tol})`);

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>Survei BMTI</name>
  <Placemark>
    <name>CP-01</name>
    <description>Atap asbes</description>
    <ExtendedData>
      <Data name="kelas"><value>Asbes</value></Data>
      <Data name="luas_m2"><value>120.5</value></Data>
    </ExtendedData>
    <Point><coordinates>107.562790,-6.874468,0</coordinates></Point>
  </Placemark>
  <Placemark>
    <name>Jalur</name>
    <LineString><coordinates>
      107.5620,-6.8740,0
      107.5625,-6.8745,0
      107.5630,-6.8750,0
    </coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>Blok</name>
    <ExtendedData><SchemaData><SimpleData name="tutupan">Sawah</SimpleData></SchemaData></ExtendedData>
    <Polygon>
      <outerBoundaryIs><LinearRing><coordinates>
        107.560,-6.880 107.570,-6.880 107.570,-6.870 107.560,-6.870 107.560,-6.880
      </coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>
        107.563,-6.877 107.566,-6.877 107.566,-6.874 107.563,-6.874 107.563,-6.877
      </coordinates></LinearRing></innerBoundaryIs>
    </Polygon>
  </Placemark>
  <Placemark><name>Tanpa geometri</name></Placemark>
</Document></kml>`;

console.log('\n== pembaca KML ==');
t('koordinat dipecah oleh spasi MAUPUN baris baru', () => {
  // ArcGIS menaruh satu koordinat per baris; parser yang hanya memecah dengan
  // spasi akan gagal senyap pada berkas itu.
  const a = parseCoordinates('107.1,-6.1,0 107.2,-6.2,0');
  const b = parseCoordinates('107.1,-6.1,0\n   107.2,-6.2,0\n');
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
});
t('koordinat dibaca sebagai lon,lat sesuai spesifikasi KML', () => {
  const c = parseCoordinates('107.562790,-6.874468,0');
  near(c[0][0], 107.56279, 1e-9, 'bujur dahulu');
  near(c[0][1], -6.874468, 1e-9, 'lintang kedua');
});
t('ketinggian nol tidak ikut disimpan', () => {
  assert.equal(parseCoordinates('107.1,-6.1,0')[0].length, 2);
  assert.equal(parseCoordinates('107.1,-6.1,850')[0].length, 3);
});

{
  const r = parse(KML);
  t('tiga Placemark bergeometri terbaca, satu dilewati', () => {
    assert.equal(r.fc.features.length, 3);
    assert.equal(r.skipped, 1);
  });
  t('nama dokumen terbaca', () => assert.equal(r.name, 'Survei BMTI'));
  t('Point, LineString, dan Polygon dikenali', () => {
    assert.deepEqual(r.fc.features.map((f) => f.geometry.type),
      ['Point', 'LineString', 'Polygon']);
  });
  t('ExtendedData Data menjadi atribut', () => {
    const p = r.fc.features[0].properties;
    assert.equal(p.kelas, 'Asbes');
    assert.equal(p.name, 'CP-01');
    assert.equal(p.description, 'Atap asbes');
  });
  t('angka bertipe teks diubah menjadi angka', () => {
    // Tanpa ini, penyaring perbandingan dan grafik tidak dapat memakainya.
    assert.equal(typeof r.fc.features[0].properties.luas_m2, 'number');
    assert.equal(r.fc.features[0].properties.luas_m2, 120.5);
  });
  t('SimpleData skema ArcGIS/QGIS ikut terbaca', () => {
    assert.equal(r.fc.features[2].properties.tutupan, 'Sawah');
  });
  t('cincin poligon tertutup dan lubangnya ikut', () => {
    const c = r.fc.features[2].geometry.coordinates;
    assert.equal(c.length, 2, 'cincin luar + satu lubang');
    assert.deepEqual(c[0][0], c[0][c[0].length - 1], 'cincin harus tertutup');
  });
}

t('KML tanpa Placemark ditolak dengan pesan jelas', () => {
  assert.throws(() => parse('<?xml version="1.0"?><kml><Document/></kml>'),
    /Placemark/);
});
t('XML rusak ditolak, bukan menghasilkan nol fitur secara senyap', () => {
  assert.throws(() => parse('<kml><Document><Placemark></kml>'),
    /tidak dapat dibaca|Placemark/);
});
t('MultiGeometry sejenis menjadi Multi* yang sah', () => {
  const r = parse(`<kml><Document><Placemark><MultiGeometry>
    <Point><coordinates>107.1,-6.1</coordinates></Point>
    <Point><coordinates>107.2,-6.2</coordinates></Point>
  </MultiGeometry></Placemark></Document></kml>`);
  assert.equal(r.fc.features[0].geometry.type, 'MultiPoint');
  assert.equal(r.fc.features[0].geometry.coordinates.length, 2);
});

console.log('\n== luas fitur ==');
// Rujukan pyproj: luar 1222291.0584, lubang 110006.0824, bersih 1112284.9760
const POLI_LUBANG = { type: 'Feature', properties: {}, geometry: { type: 'Polygon',
  coordinates: [
    [[107.560,-6.880],[107.570,-6.880],[107.570,-6.870],[107.560,-6.870],[107.560,-6.880]],
    [[107.563,-6.877],[107.566,-6.877],[107.566,-6.874],[107.563,-6.874],[107.563,-6.877]],
  ] } };

t('lubang dikurangkan dari cincin luar', () => {
  const a = featureArea(POLI_LUBANG);
  near(a, 1112284.976, 30, 'luas bersih');
});
t('mengabaikan lubang akan meleset jauh — inilah alasannya ditangani', () => {
  const tanpaLubang = { ...POLI_LUBANG, geometry: {
    type: 'Polygon', coordinates: [POLI_LUBANG.geometry.coordinates[0]] } };
  const selisih = featureArea(tanpaLubang) - featureArea(POLI_LUBANG);
  assert.ok(selisih > 100000, `selisih hanya ${selisih}`);
  console.log(`       (lubang 11 ha dari total 111 ha — 9,9% bila diabaikan)`);
});
t('MultiPolygon menjumlahkan seluruh bagiannya', () => {
  const mp = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon',
    coordinates: [POLI_LUBANG.geometry.coordinates, POLI_LUBANG.geometry.coordinates] } };
  near(featureArea(mp), 2 * featureArea(POLI_LUBANG), 1e-6);
});
t('garis dan titik berluas nol, bukan galat', () => {
  assert.equal(featureArea({ geometry: { type: 'Point', coordinates: [107,-6] } }), 0);
  assert.equal(featureArea({ geometry: null }), 0);
  assert.equal(featureArea(null), 0);
});

console.log('\n== luas per kelas ==');
const FC_LUAS = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { tutupan: 'Sawah' }, geometry: { type: 'Polygon',
    coordinates: [[[107.56,-6.88],[107.57,-6.88],[107.57,-6.87],[107.56,-6.87],[107.56,-6.88]]] } },
  { type: 'Feature', properties: { tutupan: 'Sawah' }, geometry: { type: 'Polygon',
    coordinates: [[[107.58,-6.88],[107.585,-6.88],[107.585,-6.875],[107.58,-6.875],[107.58,-6.88]]] } },
  { type: 'Feature', properties: { tutupan: 'Kebun' }, geometry: { type: 'Polygon',
    coordinates: [[[107.59,-6.88],[107.595,-6.88],[107.595,-6.875],[107.59,-6.875],[107.59,-6.88]]] } },
  { type: 'Feature', properties: { tutupan: null }, geometry: { type: 'Point', coordinates: [107,-6] } },
] };

t('luas dikelompokkan menurut nilai kolom', () => {
  const { rows, total } = areaByClass(FC_LUAS, 'tutupan');
  const sawah = rows.find((r) => r.value === 'Sawah');
  assert.equal(sawah.count, 2);
  near(sawah.area, featureArea(FC_LUAS.features[0]) + featureArea(FC_LUAS.features[1]), 1e-6);
  near(rows.reduce((a, r) => a + r.area, 0), total, 1e-6, 'jumlah baris = total');
});
t('proporsi dihitung dan berjumlah satu', () => {
  const { rows } = areaByClass(FC_LUAS, 'tutupan');
  near(rows.reduce((a, r) => a + r.share, 0), 1, 1e-9);
});
t('baris terurut dari luas terbesar', () => {
  const { rows } = areaByClass(FC_LUAS, 'tutupan');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].area >= rows[i].area, 'urutan tidak menurun');
  }
});
t('fitur tanpa luas tetap terhitung jumlahnya', () => {
  const { rows, hasArea } = areaByClass(FC_LUAS, 'tutupan');
  const kosong = rows.find((r) => r.value === '');
  assert.equal(kosong.count, 1);
  assert.equal(kosong.area, 0);
  assert.equal(hasArea, true);
});
t('mask penyaring dihormati', () => {
  const mask = new Uint8Array([1, 0, 0, 0]);
  const { rows, total } = areaByClass(FC_LUAS, 'tutupan', mask);
  assert.equal(rows.length, 1);
  near(total, featureArea(FC_LUAS.features[0]), 1e-6);
});
t('lapisan tanpa poligon ditandai hasArea=false', () => {
  const titik = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { k: 'A' }, geometry: { type: 'Point', coordinates: [107,-6] } }] };
  assert.equal(areaByClass(titik, 'k').hasArea, false);
});

console.log('\n== kelas yang dimatikan ==');
t('kelas dimatikan menghasilkan gaya tanpa garis dan isian', () => {
  const st = styleFor({ tutupan: 'Sawah' },
    { field: 'tutupan', colors: { Sawah: '#f00' }, classOff: { Sawah: true } });
  assert.equal(st.stroke, false);
  assert.equal(st.fill, false);
});
t('kelas lain tidak ikut terpengaruh', () => {
  const st = styleFor({ tutupan: 'Kebun' },
    { field: 'tutupan', colors: { Kebun: '#0f0' }, classOff: { Sawah: true } });
  assert.equal(st.fillColor, '#0f0');
});
t('tanpa classOff, tidak ada yang disembunyikan', () => {
  assert.equal(isClassHidden({ a: 'x' }, { field: 'a' }), false);
  assert.equal(isClassHidden({ a: 'x' }, {}), false);
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
