/**
 * Uji logika pembeda ketukan dan seretan pada pegangan gabungan.
 * Dijalankan lewat React di jsdom supaya hook-nya diuji apa adanya.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://x.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator',
  { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; },
};
dom.window.innerWidth = 400;    // mode ponsel
dom.window.innerHeight = 800;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { usePanelSize } = await import('../src/hooks/usePanelSize.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

let api = null;
let toggles = [];
function Probe({ open }) {
  api = usePanelSize({ open, onToggle: (v) => toggles.push(v) });
  return null;
}

const root = createRoot(document.getElementById('root'));
await act(async () => { root.render(React.createElement(Probe, { open: true })); });

const ev = (x, y) => ({
  clientX: x, clientY: y, button: 0, pointerId: 1,
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  preventDefault() {},
});

console.log('\n== pegangan gabungan: ketuk vs seret ==');

t('mode ponsel terdeteksi dari lebar jendela', () => {
  assert.equal(api.vertical, true);
});

await act(async () => {
  api.gripProps.onPointerDown(ev(200, 500));
  api.gripProps.onPointerMove(ev(202, 503));   // 3.6 px — di bawah ambang
  api.gripProps.onPointerUp(ev(202, 503));
});
t('gerakan kecil dianggap ketukan, bukan seretan', () => {
  assert.deepEqual(toggles, [false], 'ketukan harus memanggil onToggle');
  assert.equal(api.dragging, false);
});

const tinggiAwal = api.size.h;
toggles = [];
await act(async () => {
  api.gripProps.onPointerDown(ev(200, 500));
  api.gripProps.onPointerMove(ev(203, 420));   // 80 px ke atas
  api.gripProps.onPointerUp(ev(203, 420));
});
t('seretan melewati ambang tidak memicu ketukan', () => {
  assert.deepEqual(toggles, [], 'seretan tidak boleh menutup panel');
});
t('seret ke atas memperbesar panel', () => {
  assert.ok(api.size.h > tinggiAwal, `${tinggiAwal} -> ${api.size.h}`);
  // 80 px dari 800 px tinggi jendela = 10 satuan dvh
  assert.ok(Math.abs(api.size.h - (tinggiAwal + 10)) < 0.5, `${api.size.h}`);
});

const sebelumTurun = api.size.h;
await act(async () => {
  api.gripProps.onPointerDown(ev(200, 400));
  api.gripProps.onPointerMove(ev(200, 480));   // 80 px ke bawah
  api.gripProps.onPointerUp(ev(200, 480));
});
t('seret ke bawah mengecilkan panel', () => {
  assert.ok(api.size.h < sebelumTurun, `${sebelumTurun} -> ${api.size.h}`);
});

await act(async () => {
  api.gripProps.onPointerDown(ev(200, 700));
  api.gripProps.onPointerMove(ev(200, 20));    // seret ekstrem ke atas
  api.gripProps.onPointerUp(ev(200, 20));
});
t('tinggi dibatasi maksimum, panel tidak menutupi seluruh layar', () => {
  assert.ok(api.size.h <= 88, `${api.size.h}`);
});
await act(async () => {
  api.gripProps.onPointerDown(ev(200, 100));
  api.gripProps.onPointerMove(ev(200, 790));   // seret ekstrem ke bawah
  api.gripProps.onPointerUp(ev(200, 790));
});
t('tinggi dibatasi minimum, pegangan tidak pernah hilang', () => {
  assert.ok(api.size.h >= 18, `${api.size.h}`);
});

console.log('\n== menyeret panel yang tertutup ==');
toggles = [];
await act(async () => { root.render(React.createElement(Probe, { open: false })); });
await act(async () => {
  api.gripProps.onPointerDown(ev(200, 500));
  api.gripProps.onPointerMove(ev(200, 430));
  api.gripProps.onPointerUp(ev(200, 430));
});
t('menyeret panel tertutup membukanya lebih dahulu', () => {
  // Tanpa ini, pengguna menyeret sesuatu yang tidak terlihat berubah.
  assert.deepEqual(toggles, [true]);
});

console.log('\n== papan ketik ==');
await act(async () => { root.render(React.createElement(Probe, { open: true })); });
const hSebelum = api.size.h;
await act(async () => {
  api.gripProps.onKeyDown({ key: 'ArrowUp', preventDefault() {}, shiftKey: false });
});
t('panah atas memperbesar tanpa tetikus', () => {
  assert.ok(api.size.h > hSebelum);
});
await act(async () => {
  api.gripProps.onKeyDown({ key: 'Home', preventDefault() {}, shiftKey: false });
});
t('Home mengembalikan ke ukuran bawaan', () => {
  assert.equal(api.size.h, 45);
});
toggles = [];
await act(async () => {
  api.gripProps.onKeyDown({ key: 'Enter', preventDefault() {}, shiftKey: false });
});
t('Enter menutup panel, sama seperti mengetuk', () => {
  assert.deepEqual(toggles, [false]);
});

console.log('\n== ukuran tersimpan ==');
t('ukuran ditulis ke variabel CSS', () => {
  const el = document.documentElement;
  assert.match(el.style.getPropertyValue('--gt-panel-h'), /dvh$/);
  assert.match(el.style.getPropertyValue('--gt-panel-w'), /px$/);
});
t('ukuran bertahan di localStorage', () => {
  const saved = JSON.parse(localStorage.getItem('reis.panelSize'));
  assert.equal(typeof saved.h, 'number');
  assert.equal(typeof saved.w, 'number');
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
