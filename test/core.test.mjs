/**
 * test/core.test.mjs — uji modul inti tanpa DOM.
 * Jalankan: node test/core.test.mjs
 */
import assert from 'node:assert/strict';

import {
  forwardUTM, inverseUTM, meridianConvergence, describeCRS, makeTransformer,
  utmZoneFromLon, consumeZoneWarning,
} from '../src/core/geo/projection.js';
import { fitAffine, apply, invert, compose } from '../src/core/geo/affine.js';
import { buildGeoref, userToCanvasMatrix, chooseRenderScale } from '../src/core/geopdf/georefModel.js';
import { parseExpression, evaluate, INDEX_PRESETS } from '../src/core/raster/expression.js';
import { emitGLSL } from '../src/core/raster/glsl.js';
import { sampleStats, planWorkingSize } from '../src/core/raster/renderer.js';
import {
  inferSchema, compileQuery, applyQuery, queryToSQL, summarizeField, FIELD_TYPES,
} from '../src/core/vector/query.js';
import {
  buildMatrix, computeMetrics, computeAreaAdjusted, computeBinaryValidation, matrixToCSV,
} from '../src/core/accuracy/confusionMatrix.js';
import { bboxToLatLngBounds, estimateOverlaySkew } from '../src/core/geo/bounds.js';
import {
  detectVectorCRS, reprojectToWGS84, boundsOf, epsgFromCRSMember, epsgFromPRJ,
} from '../src/core/vector/reproject.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} — ${a} vs ${b} (tol ${tol})`);

console.log('\n== proyeksi ==');
t('UTM maju cocok dengan nilai rujukan pyproj (BMTI, Bandung)', () => {
  // Rujukan dihitung dengan pyproj EPSG:4326 -> EPSG:32748
  const r = forwardUTM(-6.87754, 107.56189, { zone: 48, south: true });
  near(r.x, 783128.78, 0.02, 'easting');
  near(r.y, 9239030.26, 0.02, 'northing');
});
t('UTM balik adalah inversi dari maju di dalam zona (galat < 1 mm)', () => {
  for (const [lat, lon] of [[-6.87, 107.56], [-8.5, 115.2], [1.2, 103.8], [-2.9, 104.7]]) {
    const zone = utmZoneFromLon(lon);          // zona alami, bukan dipaksa
    const f = forwardUTM(lat, lon, { zone, south: lat < 0 });
    const b = inverseUTM(f.x, f.y, zone, lat < 0);
    near(b.lat, lat, 1e-9, 'lat');
    near(b.lon, lon, 1e-9, 'lon');
  }
});
t('memaksa zona yang jauh menurunkan ketelitian dan memicu peringatan', () => {
  // Bali (115.2°E) dipaksa ke zona 48 (meridian tengah 105°) — 10.2° dari CM.
  consumeZoneWarning();
  const f = forwardUTM(-8.5, 115.2, { zone: 48, south: true });
  const w = consumeZoneWarning();
  assert.ok(w, 'peringatan zona harus terisi');
  assert.match(w.message, /meridian tengah/);
  const b = inverseUTM(f.x, f.y, 48, true);
  const errM = Math.abs(b.lat - -8.5) * 110540;
  assert.ok(errM > 0.01 && errM < 1,
    `galat ${errM} m di luar kisaran degradasi yang diharapkan`);
  console.log(`       (galat bolak-balik pada 10.2° dari CM: ${(errM * 100).toFixed(1)} cm)`);
});
t('konvergensi meridian sesuai perkiraan analitik', () => {
  // γ ≈ Δλ·sin(φ) untuk sudut kecil
  const g = meridianConvergence(-6.876, 107.56189, 48);
  const approx = (107.56189 - 105) * Math.sin((-6.876 * Math.PI) / 180);
  near(g, approx, 0.005, 'konvergensi');
  assert.ok(Math.abs(g) > 0.3 && Math.abs(g) < 0.32, `γ=${g} di luar kisaran yang diharapkan`);
});
t('WKT UTM 48S dikenali dari sidik jarinya', () => {
  const wkt = 'PROJCS["WGS_1984_UTM_Zone_48S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],' +
    'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
    'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],' +
    'PARAMETER["Central_Meridian",105.0],PARAMETER["Scale_Factor",0.9996],' +
    'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  const d = describeCRS(wkt);
  assert.equal(d.kind, 'utm');
  assert.equal(d.zone, 48);
  assert.equal(d.south, true);
});
t('EPSG:4326 diperlakukan sebagai geografis', () => {
  const tf = makeTransformer(describeCRS({ epsg: 4326 }));
  const p = tf.toCRS(-6.9, 107.6);
  assert.equal(p.x, 107.6);
  assert.equal(p.y, -6.9);
});

console.log('\n== affine ==');
t('fitAffine memulihkan transformasi yang diketahui secara persis', () => {
  const m = { a: 2, b: 0.3, c: -0.4, d: 1.7, e: 100, f: -50 };
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
  const dst = src.map((p) => apply(m, p.x, p.y));
  const { matrix, rmse } = fitAffine(src, dst);
  near(rmse, 0, 1e-9, 'rmse');
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) near(matrix[k], m[k], 1e-9, k);
});
t('fitAffine meratakan derau (rmse mendekati amplitudo derau)', () => {
  const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const noise = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]];
  const dst = src.map((p, i) => {
    const q = apply(m, p.x, p.y);
    return { x: q.x + noise[i][0], y: q.y + noise[i][1] };
  });
  const { rmse } = fitAffine(src, dst);
  assert.ok(rmse > 0.2 && rmse < 0.6, `rmse=${rmse}`);
});
t('invert dan compose menghasilkan identitas', () => {
  const m = { a: 1.3, b: 0.2, c: -0.7, d: 2.1, e: 33, f: -12 };
  const i = compose(m, invert(m));
  near(i.a, 1, 1e-12); near(i.d, 1, 1e-12);
  near(i.b, 0, 1e-12); near(i.c, 0, 1e-12);
  near(i.e, 0, 1e-9); near(i.f, 0, 1e-9);
});
t('titik kontrol kolinear ditolak, bukan menghasilkan sampah', () => {
  assert.throws(() => fitAffine(
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]
  ), /kolinear|tak tentu/i);
});

console.log('\n== georeferensi GeoPDF ==');
// Viewport nyata dari Area_3.pdf BBPPMPV BMTI (ArcGIS Pro, UTM 48S)
const VP = {
  bbox: [0, 70.866, 595.26, 841.88808],
  gpts: [
    { lat: -6.87754, lon: 107.56189 },
    { lat: -6.87425, lon: 107.56187 },
    { lat: -6.87423, lon: 107.56442 },
    { lat: -6.87753, lon: 107.56444 },
  ],
  lpts: [{ u: 0, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }, { u: 1, v: 0 }],
  crs: { kind: 'utm', zone: 48, south: true },
  encoding: 'ogc',
};

t('buildGeoref menghasilkan skala yang masuk akal', () => {
  const g = buildGeoref(VP);
  // 595.26 pt melintasi ~282 m -> ~0.47 m per titik
  near(g.metersPerPoint, 0.474, 0.01, 'm/pt');
  assert.ok(g.fitQuality.rmse < 1.5, `rmse ${g.fitQuality.rmse} m terlalu besar`);
  assert.equal(g.fitQuality.suspicious, false);
});
t('sudut bolak-balik: user -> lat/lon -> user kembali ke titik semula', () => {
  const g = buildGeoref(VP);
  for (const [ux, uy] of [[0, 70.866], [595.26, 841.888], [300, 400]]) {
    const ll = g.userToLonLat(ux, uy);
    const back = g.lonLatToUser(ll.lat, ll.lon);
    // 1e-4 titik PDF = 4.7e-5 m di tanah; jauh di bawah relevansi apa pun
    near(back.x, ux, 1e-4, 'ux');
    near(back.y, uy, 1e-4, 'uy');
  }
});
t('rotasi terdeteksi mendekati nol (lembar utara-grid)', () => {
  const g = buildGeoref(VP);
  assert.ok(Math.abs(g.rotationDeg) < 0.05, `rotasi ${g.rotationDeg}°`);
});
t('konvergensi meridian tercatat dan besarnya bermakna', () => {
  const g = buildGeoref(VP);
  assert.ok(Math.abs(g.convergenceDeg) > 0.3, `γ=${g.convergenceDeg}`);
  // Simpangan yang akan timbul bila citra ditempel tanpa koreksi, pada lembar 365 m
  const err = Math.tan((Math.abs(g.convergenceDeg) * Math.PI) / 180) * (365 / 2);
  assert.ok(err > 0.9 && err < 1.2, `simpangan sudut ${err} m`);
  console.log(`       (simpangan bila ditempel mentah: ±${err.toFixed(2)} m di sudut lembar)`);
});
t('userToCanvasMatrix membalik sumbu Y dengan benar', () => {
  const page = [0, 0, 595.26, 841.888];
  const m = userToCanvasMatrix(page, 2);
  const top = apply(m, 0, 841.888);   // kiri-atas ruang pengguna
  const bottom = apply(m, 0, 0);      // kiri-bawah
  near(top.y, 0, 1e-6, 'atas -> y=0');
  near(bottom.y, 841.888 * 2, 1e-6, 'bawah -> y=tinggi');
});
t('chooseRenderScale menghormati anggaran piksel', () => {
  const s = chooseRenderScale({ width: 595, height: 842 }, {
    metersPerPoint: 0.474, targetMetersPerPixel: 0.05, maxPixels: 24e6,
  });
  const px = 595 * 842 * s * s;
  assert.ok(px <= 24e6 * 1.01, `${px} piksel melebihi anggaran`);
  assert.ok(s > 1, 'skala harus menaikkan resolusi');
});

console.log('\n== parser ekspresi raster ==');
const BANDS = ['red', 'green', 'blue', 'nir', 'swir1'];
t('NDVI diurai dan dievaluasi dengan benar', () => {
  const { ast, usedBands } = parseExpression('(nir - red) / (nir + red)', { bands: BANDS });
  assert.deepEqual(usedBands.sort(), ['nir', 'red']);
  near(evaluate(ast, { nir: 0.5, red: 0.1 }), 0.6666666667, 1e-9);
});
t('presedensi operator dihormati', () => {
  const { ast } = parseExpression('2 + 3 * 4 ^ 2', {});
  assert.equal(evaluate(ast, {}), 50);
});
t('pangkat asosiatif kanan', () => {
  const { ast } = parseExpression('2 ^ 3 ^ 2', {});
  assert.equal(evaluate(ast, {}), 512);
});
t('unary minus dan tanda kurung bersarang', () => {
  const { ast } = parseExpression('-(3 - 5) * (2 + -1)', {});
  assert.equal(evaluate(ast, {}), 2);
});
t('where() bekerja sebagai percabangan', () => {
  const { ast } = parseExpression('where(nir > 0.3, 1, 0)', { bands: BANDS });
  assert.equal(evaluate(ast, { nir: 0.5 }), 1);
  assert.equal(evaluate(ast, { nir: 0.1 }), 0);
});
t('pembagian nol menghasilkan NaN, bukan Infinity', () => {
  const { ast } = parseExpression('red / green', { bands: BANDS });
  assert.ok(Number.isNaN(evaluate(ast, { red: 1, green: 0 })));
});
t('pita tidak dikenal ditolak dengan pesan yang menyebut daftar sah', () => {
  assert.throws(() => parseExpression('b99 * 2', { bands: BANDS }), /b99|tidak ada/i);
});
t('injeksi kode ditolak oleh lexer', () => {
  for (const bad of [
    'constructor.constructor("return 1")()',
    'red; fetch("http://x")',
    'red[0]',
    '`${red}`',
  ]) {
    assert.throws(() => parseExpression(bad, { bands: BANDS }), undefined, `seharusnya ditolak: ${bad}`);
  }
});
t('kurung tidak seimbang ditolak', () => {
  assert.throws(() => parseExpression('(nir - red', { bands: BANDS }), /Diharapkan/);
  assert.throws(() => parseExpression('nir - red)', { bands: BANDS }), /tidak terpakai/);
});
t('semua templat indeks bawaan dapat diurai', () => {
  const all = ['red', 'green', 'blue', 'nir', 'swir1', 'swir2'];
  for (const p of INDEX_PRESETS) {
    const { ast } = parseExpression(p.expr, { bands: all });
    const env = Object.fromEntries(all.map((b) => [b, 0.3]));
    const v = evaluate(ast, env);
    assert.ok(Number.isFinite(v) || Number.isNaN(v), `${p.id} menghasilkan ${v}`);
  }
});

console.log('\n== penerjemah GLSL ==');
t('emitGLSL memakai safeDiv untuk pembagian', () => {
  const { ast } = parseExpression('(nir - red) / (nir + red)', { bands: BANDS });
  const src = emitGLSL(ast, ['red', 'nir']);
  assert.match(src, /safeDiv/);
  assert.match(src, /v_band1/);   // nir adalah indeks 1
});
t('literal bilangan bulat mendapat titik desimal (GLSL menolak "2")', () => {
  const { ast } = parseExpression('nir * 2', { bands: BANDS });
  const src = emitGLSL(ast, ['nir']);
  assert.match(src, /2\.0/);
  assert.doesNotMatch(src, /\* 2\)/);
});
t('where() menjadi operator terner GLSL', () => {
  const { ast } = parseExpression('where(nir > 0.3, 1, 0)', { bands: BANDS });
  const src = emitGLSL(ast, ['nir']);
  assert.match(src, /\?/);
  assert.match(src, /:/);
});
t('pita yang tidak terikat ke sampler ditolak saat kompilasi', () => {
  const { ast } = parseExpression('nir - red', { bands: BANDS });
  assert.throws(() => emitGLSL(ast, ['nir']), /red/);
});

console.log('\n== statistik dan anggaran memori ==');
t('sampleStats memotong pencilan pada persentil 2-98', () => {
  const v = new Float32Array(10000);
  for (let i = 0; i < 10000; i++) v[i] = i / 10000;
  v[0] = -9999;      // piksel rusak
  v[9999] = 9999;
  const s = sampleStats(v, { nodata: null });
  assert.ok(s.min > -1 && s.max < 2, `min=${s.min} max=${s.max} tidak terpotong`);
});
t('sampleStats mengabaikan NoData', () => {
  const v = new Float32Array([1, 2, 3, -9999, -9999, 4, 5]);
  const s = sampleStats(v, { nodata: -9999, maxSamples: 1000 });
  assert.equal(s.count, 5);
});
t('planWorkingSize menjaga anggaran memori', () => {
  const p = planWorkingSize(10980, 10980, { bandCount: 4, maxWorkingPixels: 4e6 });
  assert.ok(p.width * p.height <= 4.1e6, `${p.width}x${p.height} terlalu besar`);
  assert.ok(p.decimation > 5);
  const kecil = planWorkingSize(800, 600, { bandCount: 4 });
  assert.equal(kecil.decimation, 1, 'citra kecil tidak boleh didesimasi');
});

console.log('\n== kueri atribut vektor ==');
const FC = {
  type: 'FeatureCollection',
  features: [
    { properties: { id: 1, atap: 'Asbes', luas: 120.5, tahun: 2021, verified: true } },
    { properties: { id: 2, atap: 'Genteng Beton', luas: 80, tahun: 2019, verified: false } },
    { properties: { id: 3, atap: 'asbes', luas: 45.2, tahun: 2022, verified: true } },
    { properties: { id: 4, atap: 'Seng', luas: 200, tahun: 2018, verified: null } },
    { properties: { id: 5, atap: 'Asbes', luas: null, tahun: 2023, verified: true } },
  ].map((f) => ({ type: 'Feature', geometry: null, ...f })),
};

t('inferSchema mengenali tipe kolom', () => {
  const s = inferSchema(FC);
  const by = Object.fromEntries(s.map((f) => [f.name, f]));
  assert.equal(by.luas.type, FIELD_TYPES.NUMBER);
  assert.equal(by.atap.type, FIELD_TYPES.STRING);
  assert.equal(by.verified.type, FIELD_TYPES.BOOLEAN);
  assert.deepEqual(by.luas.range, [45.2, 200]);
  assert.equal(by.luas.nullCount, 1);
});
t('kolom kategorikal mengumpulkan nilai unik untuk dropdown', () => {
  const s = inferSchema(FC);
  const atap = s.find((f) => f.name === 'atap');
  assert.ok(atap.categories.includes('Asbes'));
  assert.ok(atap.categories.length >= 3);
});
t('perbandingan string tidak peka huruf besar-kecil', () => {
  const schema = inferSchema(FC);
  const q = { kind: 'group', op: 'AND', rules: [
    { kind: 'rule', field: 'atap', operator: '=', value: 'ASBES' },
  ] };
  const { matched } = applyQuery(FC, compileQuery(q, schema));
  assert.equal(matched, 3, 'Asbes/asbes/ASBES harus dianggap sama');
});
t('kueri bersarang AND/OR dievaluasi dengan benar', () => {
  const schema = inferSchema(FC);
  // (atap = Asbes OR atap = Seng) AND luas > 100
  const q = {
    kind: 'group', op: 'AND', rules: [
      { kind: 'group', op: 'OR', rules: [
        { kind: 'rule', field: 'atap', operator: '=', value: 'Asbes' },
        { kind: 'rule', field: 'atap', operator: '=', value: 'Seng' },
      ] },
      { kind: 'rule', field: 'luas', operator: '>', value: 100 },
    ],
  };
  const { mask, matched } = applyQuery(FC, compileQuery(q, schema));
  assert.equal(matched, 2);
  assert.deepEqual(Array.from(mask), [1, 0, 0, 1, 0]);
});
t('between inklusif dan menerima urutan terbalik', () => {
  const schema = inferSchema(FC);
  const q = { kind: 'group', op: 'AND', rules: [
    { kind: 'rule', field: 'tahun', operator: 'between', value: 2022, value2: 2019 },
  ] };
  assert.equal(applyQuery(FC, compileQuery(q, schema)).matched, 3);
});
t('isNull membedakan null dari nol', () => {
  const schema = inferSchema(FC);
  const q = { kind: 'group', op: 'AND', rules: [
    { kind: 'rule', field: 'luas', operator: 'isNull' },
  ] };
  assert.equal(applyQuery(FC, compileQuery(q, schema)).matched, 1);
});
t('NOT pada grup membalik hasil', () => {
  const schema = inferSchema(FC);
  const q = { kind: 'group', op: 'AND', not: true, rules: [
    { kind: 'rule', field: 'atap', operator: '=', value: 'Asbes' },
  ] };
  assert.equal(applyQuery(FC, compileQuery(q, schema)).matched, 2);
});
t('grup kosong meloloskan semuanya (tidak ada filter)', () => {
  const schema = inferSchema(FC);
  assert.equal(applyQuery(FC, compileQuery({ kind: 'group', op: 'AND', rules: [] }, schema)).matched, 5);
});
t('queryToSQL menghasilkan kalimat yang dapat dibaca dan aman dari kutip', () => {
  const sql = queryToSQL({
    kind: 'group', op: 'AND', rules: [
      { kind: 'group', op: 'OR', rules: [
        { kind: 'rule', field: 'atap', operator: '=', value: "O'Brien" },
        { kind: 'rule', field: 'atap', operator: '=', value: 'Seng' },
      ] },
      { kind: 'rule', field: 'luas', operator: '>', value: 100 },
    ],
  });
  assert.match(sql, /O''Brien/, 'kutip tunggal harus di-escape');
  assert.match(sql, /\(.*OR.*\) AND/);
});
t('summarizeField menghitung statistik pada himpunan terpilih', () => {
  const mask = new Uint8Array([1, 1, 0, 0, 0]);
  const s = summarizeField(FC, mask, 'luas', FIELD_TYPES.NUMBER);
  assert.equal(s.count, 2);
  near(s.mean, 100.25, 1e-9);
});

console.log('\n== matriks konfusi ==');
const SAMPLES = [
  ...Array(45).fill({ predicted: 'Terbangun', actual: 'Terbangun' }),
  ...Array(4).fill({ predicted: 'Terbangun', actual: 'Vegetasi' }),
  ...Array(1).fill({ predicted: 'Terbangun', actual: 'Air' }),
  ...Array(6).fill({ predicted: 'Vegetasi', actual: 'Terbangun' }),
  ...Array(38).fill({ predicted: 'Vegetasi', actual: 'Vegetasi' }),
  ...Array(2).fill({ predicted: 'Vegetasi', actual: 'Air' }),
  ...Array(1).fill({ predicted: 'Air', actual: 'Terbangun' }),
  ...Array(2).fill({ predicted: 'Air', actual: 'Vegetasi' }),
  ...Array(21).fill({ predicted: 'Air', actual: 'Air' }),
];

t('matriks dibangun dengan konvensi baris=peta, kolom=rujukan', () => {
  const cm = buildMatrix(SAMPLES);
  const i = cm.classes.indexOf('Terbangun');
  const j = cm.classes.indexOf('Vegetasi');
  assert.equal(cm.matrix[i][j], 4, 'peta Terbangun, lapangan Vegetasi');
  assert.equal(cm.matrix[j][i], 6, 'peta Vegetasi, lapangan Terbangun');
});
t('OA, UA, PA dan Kappa cocok dengan hitungan tangan', () => {
  const cm = buildMatrix(SAMPLES);
  const m = computeMetrics(cm);
  assert.equal(m.total, 120);
  near(m.overallAccuracy, 104 / 120, 1e-12, 'OA');
  const terb = m.perClass.find((c) => c.name === 'Terbangun');
  near(terb.usersAccuracy, 45 / 50, 1e-12, 'UA');
  near(terb.producersAccuracy, 45 / 52, 1e-12, 'PA');
  near(terb.commissionError, 5 / 50, 1e-12, 'komisi');
  // Kappa dihitung ulang secara mandiri
  const pe = (50 / 120) * (52 / 120) + (46 / 120) * (44 / 120) + (24 / 120) * (24 / 120);
  near(m.kappa, (104 / 120 - pe) / (1 - pe), 1e-12, 'kappa');
});
t('micro-F1 identik dengan OA pada klasifikasi satu-label', () => {
  const m = computeMetrics(buildMatrix(SAMPLES));
  near(m.microF1, m.overallAccuracy, 1e-12);
});
t('selang kepercayaan OA memuat estimasi titik', () => {
  const m = computeMetrics(buildMatrix(SAMPLES));
  assert.ok(m.overallAccuracyCI95[0] < m.overallAccuracy);
  assert.ok(m.overallAccuracyCI95[1] > m.overallAccuracy);
  assert.ok(Number.isFinite(m.kappaSE));
});
t('matriks sempurna menghasilkan OA=1 dan Kappa=1', () => {
  const s = [
    ...Array(10).fill({ predicted: 'A', actual: 'A' }),
    ...Array(10).fill({ predicted: 'B', actual: 'B' }),
  ];
  const m = computeMetrics(buildMatrix(s));
  near(m.overallAccuracy, 1, 1e-12);
  near(m.kappa, 1, 1e-12);
});
t('akurasi terboboti luas berbeda dari OA mentah pada sampel berstrata', () => {
  const cm = buildMatrix(SAMPLES);
  // Air langka di peta tetapi disampel berlebih — inilah kasus yang membuat OA mentah bias
  const areas = { Terbangun: 60000, Vegetasi: 38000, Air: 2000 };
  const adj = computeAreaAdjusted(cm, areas);
  const raw = computeMetrics(cm);
  assert.ok(adj !== null);
  // Identitas Olofsson: OA terboboti = Σ W_i · UA_i
  const totalArea = 100000;
  const expected = cm.classes.reduce((acc, c, i) => {
    const W = areas[c] / totalArea;
    return acc + W * raw.perClass[i].usersAccuracy;
  }, 0);
  near(adj.overallAccuracy, expected, 1e-12, 'identitas Olofsson');
  assert.notEqual(adj.overallAccuracy, raw.overallAccuracy);
  const air = adj.perClass.find((c) => c.name === 'Air');
  assert.ok(air.adjustedArea > 0 && air.adjustedAreaCI95 > 0);
  console.log(`       (OA mentah ${computeMetrics(cm).overallAccuracy.toFixed(4)} vs ` +
    `terboboti luas ${adj.overallAccuracy.toFixed(4)})`);
});
t('validasi biner menghasilkan UA saja dan menyatakan keterbatasannya', () => {
  const bin = computeBinaryValidation([
    { predicted: 'Asbes', isCorrect: true },
    { predicted: 'Asbes', isCorrect: true },
    { predicted: 'Asbes', isCorrect: false },
    { predicted: 'Beton', isCorrect: true },
  ]);
  assert.equal(bin.n, 4);
  near(bin.overallCorrectRate, 0.75, 1e-12);
  const asbes = bin.perClass.find((c) => c.name === 'Asbes');
  near(asbes.usersAccuracy, 2 / 3, 1e-12);
  assert.match(bin.limitation, /Producer/);
});
t('CSV memuat baris total dan metrik', () => {
  const cm = buildMatrix(SAMPLES);
  const csv = matrixToCSV(cm, computeMetrics(cm));
  assert.match(csv, /Overall Accuracy/);
  assert.match(csv, /Producer's Acc/);
  assert.equal(csv.split('\r\n')[0].split(';').length, 3 + 3);
});

console.log('\n== reproyeksi bbox raster ==');
t('bbox EPSG:4326 dilewatkan tanpa diubah', () => {
  const r = bboxToLatLngBounds([107.5, -6.9, 107.6, -6.8], 4326);
  assert.equal(r.reprojected, false);
  assert.deepEqual(r.bounds, [[-6.9, 107.5], [-6.8, 107.6]]);
});
t('bbox UTM 48S direproyeksi cocok dengan pyproj', () => {
  // Cakupan BMTI dalam UTM 48S. Rujukan dari pyproj EPSG:32748 -> EPSG:4326:
  //   782805, 9239000 -> 107.558964, -6.877829
  //   783200, 9239400 -> 107.562516, -6.874195
  const r = bboxToLatLngBounds([782805, 9239000, 783200, 9239400], 32748);
  assert.equal(r.reprojected, true);
  assert.equal(r.descriptor.zone, 48);
  assert.equal(r.descriptor.south, true);
  const [[s, w], [n, e]] = r.bounds;
  near(w, 107.558964, 2e-5, 'bujur barat');
  near(e, 107.562516, 2e-5, 'bujur timur');
  near(s, -6.877829, 2e-5, 'lintang selatan');
  near(n, -6.874195, 2e-5, 'lintang utara');
});
t('bbox terproyeksi tanpa EPSG ditolak, bukan diterima diam-diam', () => {
  // Inilah kegagalan senyap yang dicegah: 783000 diperlakukan sebagai bujur.
  const r = bboxToLatLngBounds([782805, 9239000, 783200, 9239400], null);
  assert.equal(r.bounds, null);
  assert.match(r.error, /EPSG|terproyeksi/i);
});
t('pencuplikan tepi menangkap ekstremum yang dilewatkan sudut saja', () => {
  // Kelengkungan tepi hanya terlihat bila kotaknya MELINTASI meridian tengah.
  // Di zona 48 (CM 105 E = easting 500000), 400000-600000 melintasinya;
  // sepenuhnya di timur CM, lintang sepanjang tepi monoton dan sudut sudah cukup.
  const straddle = [400000, 9200000, 600000, 9310000];
  const full = bboxToLatLngBounds(straddle, 32748, { samples: 40 });
  const corners = bboxToLatLngBounds(straddle, 32748, { samples: 1 });
  const dFull = full.bounds[1][0] - full.bounds[0][0];
  const dCorner = corners.bounds[1][0] - corners.bounds[0][0];
  const selisihM = (dFull - dCorner) * 110540;
  assert.ok(selisihM > 50, `pencuplikan tepi hanya menambah ${selisihM.toFixed(1)} m`);
  console.log(`       (sudut saja melewatkan ${selisihM.toFixed(0)} m di tengah tepi)`);

  // Kontrol: seluruhnya di timur CM, sudut memang sudah cukup.
  const timur = [600000, 9200000, 710000, 9310000];
  const fT = bboxToLatLngBounds(timur, 32748, { samples: 40 });
  const cT = bboxToLatLngBounds(timur, 32748, { samples: 1 });
  const dT = ((fT.bounds[1][0] - fT.bounds[0][0]) - (cT.bounds[1][0] - cT.bounds[0][0])) * 110540;
  assert.ok(Math.abs(dT) < 1, `di timur CM seharusnya monoton, selisih ${dT}`);
});
t('estimateOverlaySkew memberi peringatan pada cakupan luas, diam pada cakupan kecil', () => {
  const kecil = bboxToLatLngBounds([782805, 9239000, 783200, 9239400], 32748);
  const sKecil = estimateOverlaySkew(kecil.bounds, kecil.descriptor);
  assert.equal(sKecil.warn, false, `citra 400 m tidak perlu peringatan (skew ${sKecil.skewMeters})`);
  assert.ok(sKecil.skewMeters < 5);

  const luas = bboxToLatLngBounds([600000, 9200000, 710000, 9310000], 32748);
  const sLuas = estimateOverlaySkew(luas.bounds, luas.descriptor);
  assert.equal(sLuas.warn, true, `citra 110 km harus diberi peringatan (skew ${sLuas.skewMeters})`);
  console.log(`       (skew imageOverlay: ${sKecil.skewMeters.toFixed(2)} m pada 400 m, ` +
    `${sLuas.skewMeters.toFixed(0)} m pada 110 km)`);
});
t('CRS yang memerlukan proj4 ditolak dengan pesan yang bisa ditindaklanjuti', () => {
  const r = bboxToLatLngBounds([100000, 200000, 110000, 210000], 23837);
  assert.equal(r.bounds, null);
  assert.match(r.error, /proj4/i);
});

console.log('\n== alur sampel ke matriks konfusi ==');
t('titik "sesuai" menghasilkan sel diagonal', () => {
  // Ini kontrak antara SampleSheet dan confusionMatrix: bila verdict true,
  // kelas rujukan disamakan dengan kelas peta. Kalau kontrak ini rusak,
  // matriksnya sunyi-sunyi salah tanpa galat apa pun.
  const s = [
    { predicted: 'Sawah', actual: 'Sawah', isCorrect: true, source: 'crosshair' },
    { predicted: 'Sawah', actual: 'Sawah', isCorrect: true, source: 'gps' },
  ];
  const cm = buildMatrix(s);
  const i = cm.classes.indexOf('Sawah');
  assert.equal(cm.matrix[i][i], 2);
  near(computeMetrics(cm).overallAccuracy, 1, 1e-12);
});
t('titik "tidak sesuai" mengisi sel di luar diagonal', () => {
  const s = [
    { predicted: 'Sawah', actual: 'Sawah', isCorrect: true },
    { predicted: 'Sawah', actual: 'Terbangun', isCorrect: false },
  ];
  const cm = buildMatrix(s);
  const r = cm.classes.indexOf('Sawah');
  const c = cm.classes.indexOf('Terbangun');
  assert.equal(cm.matrix[r][c], 1, 'peta Sawah, lapangan Terbangun');
  near(computeMetrics(cm).perClass[r].usersAccuracy, 0.5, 1e-12);
});
t('titik crosshair dan GPS bercampur dalam satu matriks', () => {
  // Sumber koordinat tidak boleh memengaruhi perhitungan akurasi tematik;
  // ia hanya jejak mutu posisi.
  const s = [
    { predicted: 'A', actual: 'A', isCorrect: true, source: 'gps', accuracyFlagged: true },
    { predicted: 'A', actual: 'B', isCorrect: false, source: 'crosshair' },
    { predicted: 'B', actual: 'B', isCorrect: true, source: 'crosshair' },
  ];
  const m = computeMetrics(buildMatrix(s));
  assert.equal(m.total, 3);
  near(m.overallAccuracy, 2 / 3, 1e-12);
});
t('titik yang belum diisi kelas rujukannya tidak merusak matriks', () => {
  const s = [
    { predicted: 'A', actual: 'A', isCorrect: true },
    { predicted: 'B', actual: '', isCorrect: false },   // rujukan kosong
  ];
  const cm = buildMatrix(s);
  assert.equal(cm.skipped, 1, 'baris tanpa kelas rujukan harus dilewati, bukan dihitung');
  assert.equal(cm.n, 1);
});

console.log('\n== CRS data vektor ==');
const FC_UTM = { type: 'FeatureCollection', features: [{
  type: 'Feature', properties: { nama: 'Batas' },
  geometry: { type: 'Polygon', coordinates: [[
    [782805, 9239000], [783200, 9239000], [783200, 9239400], [782805, 9239400], [782805, 9239000],
  ]] },
}] };

t('koordinat UTM dikenali sebagai terproyeksi, bukan diterima diam-diam', () => {
  const d = detectVectorCRS(FC_UTM);
  assert.equal(d.kind, 'projected');
  assert.equal(d.likelySouth, true, 'northing > 1e6 menandakan belahan selatan');
});
t('koordinat lintang-bujur dikenali sebagai geografis', () => {
  const fc = { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [107.56, -6.87] } }] };
  assert.equal(detectVectorCRS(fc).kind, 'geographic');
});
t('anggota crs gaya lama terbaca dalam kedua bentuknya', () => {
  assert.equal(epsgFromCRSMember({ crs: { properties: { name: 'EPSG:32748' } } }), 32748);
  assert.equal(epsgFromCRSMember({
    crs: { properties: { name: 'urn:ogc:def:crs:EPSG::32748' } } }), 32748);
  assert.equal(epsgFromCRSMember({}), null);
});
t('EPSG dibaca dari .prj lewat AUTHORITY maupun nama zona', () => {
  assert.equal(epsgFromPRJ('PROJCS["x",AUTHORITY["EPSG","32748"]]'), 32748);
  assert.equal(epsgFromPRJ('PROJCS["WGS_1984_UTM_Zone_48S",PROJECTION["Transverse_Mercator"]]'), 32748);
  assert.equal(epsgFromPRJ('PROJCS["WGS_1984_UTM_Zone_49N"]'), 32649);
});
t('reproyeksi UTM 48S menghasilkan koordinat yang cocok dengan pyproj', () => {
  const { fc, reprojected } = reprojectToWGS84(FC_UTM, 32748);
  assert.equal(reprojected, true);
  const ring = fc.features[0].geometry.coordinates[0];
  // 782805, 9239000 -> 107.558964, -6.877829 (pyproj)
  near(ring[0][0], 107.558964, 2e-5, 'bujur');
  near(ring[0][1], -6.877829, 2e-5, 'lintang');
  assert.equal(ring.length, 5, 'cincin poligon harus tetap tertutup');
});
t('reproyeksi mempertahankan properti dan struktur geometri', () => {
  const { fc } = reprojectToWGS84(FC_UTM, 32748);
  assert.equal(fc.features[0].properties.nama, 'Batas');
  assert.equal(fc.features[0].geometry.type, 'Polygon');
  assert.equal(fc.crs, undefined, 'anggota crs harus dibuang, sesuai RFC 7946');
});
t('data yang sudah geografis dilewatkan tanpa diubah', () => {
  const fc = { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [107.56, -6.87] } }] };
  const r = reprojectToWGS84(fc, 4326);
  assert.equal(r.reprojected, false);
  assert.equal(r.fc, fc);
});
t('boundsOf menghitung kotak yang benar setelah reproyeksi', () => {
  const { fc } = reprojectToWGS84(FC_UTM, 32748);
  const b = boundsOf(fc);
  near(b[0][1], 107.5589, 1e-3, 'bujur barat');
  near(b[1][0], -6.8742, 1e-3, 'lintang utara');
});
t('titik tunggal diberi margin supaya fitBounds tidak melompat ke zoom maksimum', () => {
  const fc = { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [107.56, -6.87] } }] };
  const b = boundsOf(fc);
  assert.ok(b[1][0] > b[0][0], 'kotak tidak boleh berukuran nol');
  const tinggiM = (b[1][0] - b[0][0]) * 110540;
  assert.ok(tinggiM > 100 && tinggiM < 1000, `margin ${tinggiM} m di luar kisaran wajar`);
});
t('geometri bertingkat (MultiPolygon) ikut tereproyeksi seluruhnya', () => {
  const fc = { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [[[
      [782805, 9239000], [783200, 9239000], [783200, 9239400], [782805, 9239000],
    ]]] } }] };
  const { fc: out } = reprojectToWGS84(fc, 32748);
  const pt = out.features[0].geometry.coordinates[0][0][0];
  assert.ok(Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90, `masih terproyeksi: ${pt}`);
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
