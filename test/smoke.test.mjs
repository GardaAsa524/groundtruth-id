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


/* --------------------------------------------- 0. keutuhan dependensi */

console.log('\n== dependensi terdeklarasi ==');

/**
 * MENGAPA UJI INI ADA
 * -------------------
 * Sebuah build gagal di GitHub Actions padahal `npm run build` lokal berhasil.
 * Sebabnya: sebuah paket dihapus dari package.json tetapi impornya masih
 * tertinggal di kode. Secara lokal build tetap jalan karena paketnya masih
 * fisik ada di node_modules dari pemasangan sebelumnya; CI memasang dari nol,
 * sehingga di sanalah baru ketahuan.
 *
 * Pemeriksaan ini membandingkan setiap impor paket di dalam src/ terhadap
 * daftar dependensi — tanpa bergantung pada apa yang kebetulan ada di disk.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** Telusuri seluruh berkas sumber secara rekursif. */
function walkSrc(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const u = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) walkSrc(u, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(u);
  }
  return out;
}

const srcFiles = walkSrc(new URL('../src/', import.meta.url));
const IMPORT_RE = /(?:import\s[^'"]*from\s*|import\s*\(\s*|export\s[^'"]*from\s*)['"]([^'"]+)['"]/g;

const missing = new Map();
for (const f of srcFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    // Lewati impor relatif, alias virtual Vite, dan URL absolut.
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('virtual:')
        || spec.startsWith('http')) continue;
    // Nama paket: buang subjalur, pertahankan lingkup @scope/nama.
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (declared.has(name)) continue;
    if (!missing.has(name)) missing.set(name, []);
    missing.get(name).push(f.pathname.split('/src/')[1]);
  }
}

t(`setiap impor paket terdaftar di package.json (${srcFiles.length} berkas dipindai)`, () => {
  const lines = [...missing.entries()]
    .map(([n, files]) => `${n} dipakai di ${[...new Set(files)].join(', ')}`);
  assert.equal(
    missing.size, 0,
    `paket tidak terdeklarasi:\n       ${lines.join('\n       ')}\n\n       ` +
    'DUA PENYEBAB YANG MUNGKIN:\n       ' +
    '1. Impor tertinggal setelah paketnya dihapus dari package.json.\n       ' +
    '2. Berkas lama masih ada di repo. Unggah lewat antarmuka web GitHub hanya\n       ' +
    '   menambah dan menimpa — ia TIDAK PERNAH menghapus berkas yang sudah tidak\n       ' +
    '   ada di unggahan baru. Hapus folder src/ dan test/ lebih dahulu, baru unggah.\n       ' +
    `   (dipindai ${srcFiles.length} berkas; bandingkan dengan isi arsip)`
  );
});

/* ------------------------------------------------- 1. analisis statis JSX */

console.log('\n== penempatan komponen peta ==');

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

// Komponen mana saja yang memanggil useMap()?
const HOOK_RE = /\buse(Map|MapEvents?)\s*\(/;

const compDir = new URL('../src/components/', import.meta.url);
const usesMap = new Set();
for (const f of readdirSync(compDir)) {
  if (!f.endsWith('.jsx')) continue;
  const src = readFileSync(new URL(f, compDir), 'utf8');
  // useMapEvents dan useMapEvent juga memerlukan konteks MapContainer;
  // memindai useMap saja meninggalkan celah yang persis sejenis.
  if (!HOOK_RE.test(src)) continue;
  HOOK_RE.lastIndex = 0;
  // Ambil nama komponen yang diekspor dari berkas itu
  for (const m of src.matchAll(/export function (\w+)/g)) {
    // Hanya yang benar-benar memanggil useMap di dalam badannya
    const start = m.index;
    const next = src.indexOf('\nexport function', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    HOOK_RE.lastIndex = 0;
    if (HOOK_RE.test(body)) usesMap.add(m[1]);
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

  // Geoman dimuat lewat impor dinamis; beri waktu janji-janjinya selesai
  // sebelum memeriksa DOM.
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    if (/leaflet-pm-toolbar|leaflet-pm-draw/.test(
      document.getElementById('root').innerHTML)) break;
  }
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

/**
 * Kendali digitasi harus benar-benar terpasang, bukan sekadar tidak melempar
 * galat.
 *
 * Bug yang memunculkan uji ini: DrawingTools memuat Geoman lewat impor dinamis
 * di dalam useEffect. Salah satu dependensi effect berubah identitasnya pada
 * setiap render (`defaultProperties = {}` menghasilkan objek baru tiap kali),
 * sehingga effect dibongkar dan dipasang ulang terus-menerus. Fungsi pembersih
 * menyetel `disposed = true` sebelum impor dinamisnya selesai, dan badan effect
 * keluar lebih awal tanpa pernah memanggil addControls.
 *
 * Kegagalannya sepenuhnya senyap: tidak ada galat, tidak ada peringatan, dan
 * seluruh uji lain tetap hijau. Yang hilang hanya bilah alat gambar di peta.
 */
t('kendali digitasi Geoman benar-benar terpasang di peta', () => {
  const html2 = document.getElementById('root').innerHTML;
  assert.ok(
    /leaflet-pm-toolbar|leaflet-pm-draw/.test(html2),
    'bilah alat Geoman tidak ada di DOM — kendali gambar tidak terpasang'
  );
});

t('tidak ada galat React yang tercatat', () => {
  const nyata = errors.filter((e) =>
    !/not wrapped in act|Warning: ReactDOM.render|deprecated/i.test(e));
  assert.equal(nyata.length, 0, nyata.slice(0, 2).join('\n       '));
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
