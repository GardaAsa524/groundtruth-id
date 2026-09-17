/**
 * test/css.test.mjs — konflik kaskade pada lembar gaya.
 *
 * MENGAPA UJI INI ADA
 * -------------------
 * Header aplikasi tampil di tengah, bukan rata kiri, padahal aturan yang
 * benar sudah ditulis. Penyebabnya: aturan `.gt-brand` lama tertinggal di
 * AKHIR berkas dan menimpa yang baru di awal. CSS tidak melaporkan apa pun —
 * aturan terakhir sekadar menang, dan tata letaknya berubah diam-diam.
 *
 * Pemeriksaan visual tidak menangkapnya, karena saya membuat pratinjau dari
 * SVG buatan tangan alih-alih dari lembar gaya yang sebenarnya. Uji ini
 * membaca berkas gayanya langsung.
 *
 * Yang dicari bukan sekadar selektor yang muncul dua kali — itu lazim dan
 * sering disengaja — melainkan selektor yang menyetel PROPERTI YANG SAMA
 * dengan NILAI BERBEDA di tingkat atas. Di situlah salah satunya pasti mati.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

/** Buang komentar dan seluruh isi @media, sisakan aturan tingkat atas. */
function topLevel(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '', i = 0;
  while (i < s.length) {
    if (s.startsWith('@media', i) || s.startsWith('@supports', i)
        || s.startsWith('@keyframes', i)) {
      let j = s.indexOf('{', i);
      if (j < 0) break;
      let d = 1; j++;
      while (j < s.length && d > 0) {
        if (s[j] === '{') d++;
        else if (s[j] === '}') d--;
        j++;
      }
      i = j;
      continue;
    }
    out += s[i++];
  }
  return out;
}

function deklarasi(body) {
  const map = new Map();
  for (const bagian of body.split(';')) {
    const k = bagian.indexOf(':');
    if (k < 0) continue;
    const prop = bagian.slice(0, k).trim();
    const nilai = bagian.slice(k + 1).trim().replace(/\s+/g, ' ');
    if (prop && !prop.startsWith('--')) map.set(prop, nilai);
  }
  return map;
}

const berkasGaya = readdirSync(new URL('../src/styles/', import.meta.url))
  .filter((f) => f.endsWith('.css'));

console.log('\n== konflik kaskade ==');

for (const nama of berkasGaya) {
  const css = readFileSync(new URL(`../src/styles/${nama}`, import.meta.url), 'utf8');
  const aturan = new Map();          // selektor -> [Map properti]

  for (const m of topLevel(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = deklarasi(m[2]);
    for (const sel of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!aturan.has(sel)) aturan.set(sel, []);
      aturan.get(sel).push(decls);
    }
  }

  const konflik = [];
  for (const [sel, daftar] of aturan) {
    if (daftar.length < 2) continue;
    for (let i = 1; i < daftar.length; i++) {
      for (const [prop, nilai] of daftar[i]) {
        for (let k = 0; k < i; k++) {
          const lama = daftar[k].get(prop);
          if (lama !== undefined && lama !== nilai) {
            konflik.push(`${sel} { ${prop} }: "${lama}" ditimpa "${nilai}"`);
          }
        }
      }
    }
  }

  t(`${nama} tidak memuat properti yang saling menimpa`, () => {
    assert.equal(konflik.length, 0,
      `aturan yang saling mematikan:\n       ${konflik.join('\n       ')}`);
  });
}

console.log('\n== kelas yang dipakai komponen ada gayanya ==');
{
  const semuaCss = berkasGaya
    .map((f) => readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8'))
    .join('\n');

  function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(u, out);
      else if (/\.jsx$/.test(e.name)) out.push(u);
    }
    return out;
  }

  const dipakai = new Set();
  for (const f of walk(new URL('../src/', import.meta.url))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/className=["']([^"'{}]+)["']/g)) {
      for (const c of m[1].split(/\s+/)) if (c.startsWith('gt-')) dipakai.add(c);
    }
  }

  const yatim = [...dipakai].filter((c) => !semuaCss.includes(`.${c}`));
  t(`setiap kelas gt-* punya aturan gaya (${dipakai.size} kelas dipindai)`, () => {
    assert.equal(yatim.length, 0,
      `kelas tanpa gaya:\n       ${yatim.join(', ')}`);
  });
}

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
