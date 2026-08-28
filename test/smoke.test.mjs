/**
 * test/smoke.test.mjs — memasang App yang sebenarnya di dalam jsdom.
 *
 * MENGAPA UJI INI ADA
 * -------------------
 * Uji unit dan pemeriksaan bundel keduanya lulus, tetapi aplikasi tetap
 * menampilkan halaman putih di produksi. Penyebabnya: sebuah komponen yang
 * memanggil `useMap()` dirender di dalam panel samping, di luar
 * <MapContainer>. react-leaflet melempar galat, React membatalkan seluruh
 * pohon, dan tidak ada yang tergambar.
 *
 * Kelas kesalahan ini tidak terlihat oleh esbuild (sintaksnya sah), tidak
 * terlihat oleh uji logika inti (tidak menyentuh React), dan tidak terlihat
 * oleh `vite build` (bundelnya berhasil dibuat). Ia hanya muncul saat komponen
 * benar-benar dipasang. Karena itu satu-satunya cara menangkapnya sebelum
 * sampai ke lapangan adalah benar-benar memasangnya.
 *
 * Uji ini juga menegaskan aturan yang lebih umum: setiap komponen yang memakai
 * useMap() wajib berada di dalam MapContainer.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; }
};

/* ------------------------------------------------- 1. analisis statis JSX */

console.log('\n== penempatan komponen peta ==');

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

// Komponen mana saja yang memanggil useMap()?
const compDir = new URL('../src/components/', import.meta.url);
const usesMap = new Set();
for (const f of readdirSync(compDir)) {
  if (!f.endsWith('.jsx')) continue;
  const src = readFileSync(new URL(f, compDir), 'utf8');
  if (!/\buseMap\s*\(/.test(src)) continue;
  // Ambil nama komponen yang diekspor dari berkas itu
  for (const m of src.matchAll(/export function (\w+)/g)) {
    // Hanya yang benar-benar memanggil useMap di dalam badannya
    const start = m.index;
    const next = src.indexOf('\nexport function', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    if (/\buseMap\s*\(/.test(body)) usesMap.add(m[1]);
  }
}

// Batas <MapContainer> di dalam App.jsx
const mcOpen = app.indexOf('<MapContainer');
const mcClose = app.indexOf('</MapContainer>');
assert.ok(mcOpen > -1 && mcClose > mcOpen, 'MapContainer tidak ditemukan di App.jsx');

t(`komponen ber-useMap terdeteksi (${[...usesMap].join(', ')})`, () => {
  assert.ok(usesMap.size >= 4, `hanya ${usesMap.size} terdeteksi, kemungkinan pemindaian gagal`);
});

for (const name of [...usesMap].sort()) {
  t(`<${name}> dirender di dalam <MapContainer>`, () => {
    const re = new RegExp(`<${name}[\\s/>]`, 'g');
    const positions = [...app.matchAll(re)].map((m) => m.index);
    if (positions.length === 0) return;               // tidak dipakai di App
    const luar = positions.filter((p) => p < mcOpen || p > mcClose);
    assert.equal(
      luar.length, 0,
      `<${name}> memanggil useMap() tetapi dirender di luar <MapContainer> ` +
      `(posisi ${luar.join(', ')}; MapContainer ${mcOpen}-${mcClose}). ` +
      'Ini menyebabkan halaman putih total, bukan sekadar komponen yang hilang.'
    );
  });
}

/* ------------------------------------------------------ 2. pemasangan nyata */

console.log('\n== pemasangan App di jsdom ==');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://contoh.test/groundtruth-id/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Lengkapi API peramban yang tidak disediakan jsdom tetapi dipakai Leaflet,
// React, dan hook geolokasi.
globalThis.window = window;
globalThis.document = window.document;
// Node 22 memaparkan globalThis.navigator hanya lewat getter, sehingga
// penetapan langsung melempar galat. defineProperty menggantikannya.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Image = window.Image;
globalThis.SVGElement = window.SVGElement;
// Geoman menambal prototipe DOM saat dimuat dan mengandaikan global ini ada.
globalThis.CharacterData = window.CharacterData;
globalThis.DocumentType = window.DocumentType;
globalThis.Document = window.Document;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.TouchEvent = window.TouchEvent ?? window.Event;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame ?? ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = window.cancelAnimationFrame ?? clearTimeout;
globalThis.matchMedia = window.matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.isSecureContext = true;
// Tanpa penanda ini React memperingatkan bahwa act() tidak didukung dan
// pembaruan status tidak dijalankan sampai tuntas.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};
if (!window.navigator.geolocation) {
  Object.defineProperty(window.navigator, 'geolocation', {
    value: { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} },
    configurable: true,
  });
}
// Leaflet memeriksa dukungan kanvas saat dimuat.
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
    setTransform() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, clip() {}, putImageData() {}, createImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
};

// Kumpulkan galat konsol: React melaporkan kegagalan render lewat console.error.
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

// Node tidak dapat mengimpor .jsx secara langsung, jadi App dibundel lebih
// dahulu dengan esbuild ke berkas .mjs sementara. Ini juga menguji bahwa
// seluruh rantai impor benar-benar dapat diselesaikan.
const bundlePath = new URL('../node_modules/.cache/gt-smoke-app.mjs', import.meta.url);
{
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [new URL('../src/App.jsx', import.meta.url).pathname],
    outfile: bundlePath.pathname,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    // React harus dibiarkan eksternal. Bila ikut terbundel, bundel memakai
    // salinan React sendiri sementara uji memakai salinan lain, dan React
    // menolaknya dengan "Invalid hook call ... more than one copy of React".
    external: ['react', 'react-dom', 'react-dom/client'],
    logLevel: 'silent',
  });
}

let mountError = null;
let html = '';
try {
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const App = (await import(bundlePath.href)).default;

  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(App)); });
  html = document.getElementById('root').innerHTML;
} catch (e) {
  mountError = e;
} finally {
  console.error = origError;
}

t('App terpasang tanpa melempar galat', () => {
  assert.equal(mountError, null, mountError ? mountError.message : '');
});

t('DOM tidak kosong setelah render', () => {
  assert.ok(html.length > 500, `hanya ${html.length} karakter tergambar — indikasi halaman putih`);
});

t('elemen kunci antarmuka tergambar', () => {
  for (const cls of ['gt-app', 'gt-sidebar', 'gt-map-wrap', 'gt-tabs']) {
    assert.ok(html.includes(cls), `kelas "${cls}" tidak ditemukan pada hasil render`);
  }
});

t('tidak ada galat React yang tercatat', () => {
  const nyata = errors.filter((e) =>
    !/not wrapped in act|Warning: ReactDOM.render|deprecated/i.test(e));
  assert.equal(nyata.length, 0, nyata.slice(0, 2).join('\n       '));
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
