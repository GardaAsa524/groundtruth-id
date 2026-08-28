/** test/render.test.mjs — jalur render CPU, paritas i18n, dan pembersihan ekspor. */
import assert from 'node:assert/strict';
import { parseExpression, evaluate } from '../src/core/raster/expression.js';
import { renderCPU } from '../src/core/raster/renderer.js';
import { rampToPixels, COLORMAPS } from '../src/core/raster/glsl.js';
import { STRINGS } from '../src/i18n/strings.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

console.log('\n== gradien warna ==');
t('rampToPixels menginterpolasi mulus antar titik henti', () => {
  const px = rampToPixels(['#000000', '#ffffff'], 256);
  assert.equal(px[0], 0);
  assert.equal(px[255 * 4], 255);
  assert.ok(Math.abs(px[128 * 4] - 128) <= 1, `titik tengah ${px[128 * 4]}`);
  assert.equal(px[3], 255, 'alpha harus opak');
});
t('semua gradien bawaan menghasilkan panjang yang benar', () => {
  for (const [name, stops] of Object.entries(COLORMAPS)) {
    const px = rampToPixels(stops, 256);
    assert.equal(px.length, 1024, name);
  }
});

console.log('\n== render CPU ==');
const W = 4, H = 2;
const red = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, -9999, 0.7, 0.8]);
const nir = Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, -9999, 0.5, 0.5]);

t('renderCPU menandai NoData sebagai transparan penuh', () => {
  const { ast } = parseExpression('(nir - red) / (nir + red)', { bands: ['red', 'nir'] });
  const img = renderCPU({
    evaluateFn: evaluate, ast, bandData: { red, nir }, bands: ['red', 'nir'],
    width: W, height: H, min: -1, max: 1, colormap: 'rdylgn', opacity: 1, nodata: -9999,
  });
  assert.equal(img.data[5 * 4 + 3], 0, 'piksel NoData harus alpha 0');
  assert.equal(img.data[0 * 4 + 3], 255, 'piksel sah harus opak');
});
t('nilai NDVI dipetakan ke posisi gradien yang benar', () => {
  const { ast } = parseExpression('(nir - red) / (nir + red)', { bands: ['red', 'nir'] });
  const img = renderCPU({
    evaluateFn: evaluate, ast, bandData: { red, nir }, bands: ['red', 'nir'],
    width: W, height: H, min: -1, max: 1, colormap: 'grayscale', opacity: 1, nodata: -9999,
  });
  // piksel 0: NDVI = (0.5-0.1)/(0.6) = 0.6667 -> t = 0.8333 -> abu ~212
  const v = img.data[0];
  assert.ok(Math.abs(v - 212) <= 2, `nilai kelabu ${v}, diharapkan ~212`);
  // piksel 3: NDVI = (0.5-0.4)/0.9 = 0.1111 -> t = 0.5556 -> ~142
  assert.ok(Math.abs(img.data[3 * 4] - 142) <= 2, `nilai kelabu ${img.data[3 * 4]}`);
});
t('pembagian nol pada CPU menghasilkan piksel transparan, bukan hitam', () => {
  const { ast } = parseExpression('red / nir', { bands: ['red', 'nir'] });
  const zero = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0]);
  const img = renderCPU({
    evaluateFn: evaluate, ast, bandData: { red, nir: zero }, bands: ['red', 'nir'],
    width: W, height: H, min: 0, max: 1, colormap: 'viridis', opacity: 1, nodata: null,
  });
  for (let i = 0; i < W * H; i++) assert.equal(img.data[i * 4 + 3], 0, `piksel ${i}`);
});
t('opacity diterapkan pada saluran alpha', () => {
  const { ast } = parseExpression('nir', { bands: ['nir'] });
  const img = renderCPU({
    evaluateFn: evaluate, ast, bandData: { nir }, bands: ['nir'],
    width: W, height: H, min: 0, max: 1, colormap: 'viridis', opacity: 0.5, nodata: -9999,
  });
  assert.equal(img.data[3], 128);
});

console.log('\n== paritas i18n ==');
t('kunci id dan en identik', () => {
  const id = Object.keys(STRINGS.id).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(id, en);
});
t('placeholder cocok antarbahasa', () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(STRINGS.id)) {
    assert.equal(ph(STRINGS.id[k]), ph(STRINGS.en[k]), `placeholder berbeda pada "${k}"`);
  }
});
t('tidak ada nilai kosong', () => {
  for (const loc of ['id', 'en']) {
    for (const [k, v] of Object.entries(STRINGS[loc])) {
      assert.ok(String(v).trim().length > 0, `${loc}.${k} kosong`);
    }
  }
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
