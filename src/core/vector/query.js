/**
 * core/vector/query.js
 * ---------------------------------------------------------------------------
 * Penyusun kueri atribut: skema, pohon aturan, dan kompilasi ke predikat.
 *
 * Rancangan berdasarkan dua kendala nyata:
 *
 * 1. KEAMANAN — sama seperti kalkulator raster, kueri bisa berasal dari
 *    templat bersama. Tidak ada `new Function`. Pohon aturan berbentuk data
 *    murni sehingga bisa disimpan ke Google Sheets, dibagikan, dan divalidasi.
 *
 * 2. KINERJA — memfilter ulang seluruh FeatureCollection pada setiap ketikan
 *    membuat antarmuka tersendat pada 20.000 poligon. Karena itu:
 *    - predikat dikompilasi sekali menjadi satu closure,
 *    - hasilnya berupa Uint8Array bitmask, bukan salinan array fitur,
 *    - lapisan Leaflet mengubah gaya berdasarkan bitmask, bukan dibangun ulang.
 *      Membangun ulang L.geoJSON untuk 20.000 poligon berarti membuang dan
 *      membuat ulang 20.000 elemen SVG; mengubah gaya hanya menyentuh atribut.
 */

/* ------------------------------------------------------------------ skema */

export const FIELD_TYPES = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

/**
 * Simpulkan tabel atribut dari FeatureCollection.
 *
 * Mencuplik, bukan memindai semuanya: 500 fitur pertama sudah cukup untuk
 * menentukan tipe, dan pemindaian penuh pada berkas 100 MB akan menahan
 * thread utama selama beberapa detik.
 *
 * Untuk kolom kategorikal, nilai unik dikumpulkan sampai batas tertentu supaya
 * antarmuka bisa menampilkan dropdown, bukan kotak teks bebas — ini mengurangi
 * salah ketik pada kelas seperti "Genteng Beton" vs "genteng beton".
 */
export function inferSchema(featureCollection, { sampleSize = 500, maxCategories = 60 } = {}) {
  const feats = featureCollection?.features ?? [];
  const n = Math.min(feats.length, sampleSize);
  const fields = new Map();

  for (let i = 0; i < n; i++) {
    const props = feats[i]?.properties;
    if (!props) continue;
    for (const [key, raw] of Object.entries(props)) {
      let f = fields.get(key);
      if (!f) {
        f = { name: key, types: new Set(), values: new Set(), nulls: 0, min: Infinity, max: -Infinity };
        fields.set(key, f);
      }
      if (raw === null || raw === undefined || raw === '') { f.nulls++; continue; }

      if (typeof raw === 'number' && Number.isFinite(raw)) {
        f.types.add(FIELD_TYPES.NUMBER);
        if (raw < f.min) f.min = raw;
        if (raw > f.max) f.max = raw;
      } else if (typeof raw === 'boolean') {
        f.types.add(FIELD_TYPES.BOOLEAN);
      } else {
        const s = String(raw);
        f.types.add(DATE_RE.test(s) ? FIELD_TYPES.DATE : FIELD_TYPES.STRING);
        if (f.values.size <= maxCategories) f.values.add(s);
      }
    }
  }

  return [...fields.values()].map((f) => {
    // Kolom bertipe campuran diperlakukan sebagai string: itu satu-satunya
    // tipe yang selalu dapat menampung isinya tanpa memaksa konversi diam-diam.
    const type = f.types.size === 1 ? [...f.types][0] : FIELD_TYPES.STRING;
    const categorical =
      (type === FIELD_TYPES.STRING || type === FIELD_TYPES.BOOLEAN) &&
      f.values.size > 0 && f.values.size <= maxCategories;
    return {
      name: f.name,
      type,
      nullCount: f.nulls,
      categories: categorical ? [...f.values].sort() : null,
      range: type === FIELD_TYPES.NUMBER && f.min <= f.max ? [f.min, f.max] : null,
      sampled: n,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------- model kueri */

/**
 * Pohon aturan:
 *   Group  = { kind:'group', op:'AND'|'OR', not?:boolean, rules: Node[] }
 *   Rule   = { kind:'rule', field, operator, value, value2? }
 *
 * Bentuk pohon (bukan daftar datar) penting karena pertanyaan lapangan yang
 * sebenarnya berbentuk bersarang, misalnya:
 *   (atap = 'Asbes' OR atap = 'Seng') AND luas > 50 AND tahun >= 2020
 */

export const OPERATORS = {
  [FIELD_TYPES.STRING]: ['=', '!=', 'contains', 'startsWith', 'in', 'isNull', 'notNull'],
  [FIELD_TYPES.NUMBER]: ['=', '!=', '<', '<=', '>', '>=', 'between', 'isNull', 'notNull'],
  [FIELD_TYPES.BOOLEAN]: ['=', '!=', 'isNull', 'notNull'],
  [FIELD_TYPES.DATE]: ['=', '!=', '<', '<=', '>', '>=', 'between', 'isNull', 'notNull'],
};

export function emptyGroup(op = 'AND') {
  return { kind: 'group', op, rules: [] };
}

export function newRule(field) {
  return {
    kind: 'rule',
    field: field?.name ?? '',
    operator: field?.type === FIELD_TYPES.NUMBER ? '>=' : '=',
    value: '',
  };
}

/* ------------------------------------------------------- kompilasi predikat */

const norm = (v) => (v === null || v === undefined ? null : v);
const asNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const asDate = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Kompilasi satu aturan menjadi fungsi (props) => boolean.
 * Pengubahan tipe dilakukan sekali di sini, bukan pada tiap fitur — inilah
 * perbedaan antara 20 ms dan 400 ms pada 20.000 poligon.
 */
function compileRule(rule, schemaByName) {
  const field = rule.field;
  const type = schemaByName.get(field)?.type ?? FIELD_TYPES.STRING;
  const op = rule.operator;

  if (op === 'isNull') return (p) => norm(p?.[field]) === null || p?.[field] === '';
  if (op === 'notNull') return (p) => norm(p?.[field]) !== null && p?.[field] !== '';

  if (type === FIELD_TYPES.NUMBER || type === FIELD_TYPES.DATE) {
    const conv = type === FIELD_TYPES.NUMBER ? asNum : asDate;
    const a = conv(rule.value);
    const b = conv(rule.value2);
    if (a === null && op !== 'between') return () => false;
    switch (op) {
      case '=': return (p) => conv(p?.[field]) === a;
      case '!=': return (p) => conv(p?.[field]) !== a;
      case '<': return (p) => { const v = conv(p?.[field]); return v !== null && v < a; };
      case '<=': return (p) => { const v = conv(p?.[field]); return v !== null && v <= a; };
      case '>': return (p) => { const v = conv(p?.[field]); return v !== null && v > a; };
      case '>=': return (p) => { const v = conv(p?.[field]); return v !== null && v >= a; };
      case 'between': {
        if (a === null || b === null) return () => false;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return (p) => { const v = conv(p?.[field]); return v !== null && v >= lo && v <= hi; };
      }
      default: return () => false;
    }
  }

  // String dan boolean. Perbandingan string tidak peka huruf besar-kecil:
  // data lapangan penuh dengan "Asbes", "asbes", dan "ASBES" untuk hal sama.
  const target = String(rule.value ?? '').trim().toLowerCase();
  switch (op) {
    case '=': return (p) => String(norm(p?.[field]) ?? '').trim().toLowerCase() === target;
    case '!=': return (p) => String(norm(p?.[field]) ?? '').trim().toLowerCase() !== target;
    case 'contains': return (p) => String(norm(p?.[field]) ?? '').toLowerCase().includes(target);
    case 'startsWith': return (p) => String(norm(p?.[field]) ?? '').toLowerCase().startsWith(target);
    case 'in': {
      const set = new Set(
        (Array.isArray(rule.value) ? rule.value : String(rule.value).split(','))
          .map((s) => String(s).trim().toLowerCase())
          .filter(Boolean)
      );
      return (p) => set.has(String(norm(p?.[field]) ?? '').trim().toLowerCase());
    }
    default: return () => false;
  }
}

/**
 * Kompilasi pohon menjadi satu predikat.
 * @returns {(props:object)=>boolean}
 */
export function compileQuery(node, schema) {
  const byName = new Map((schema ?? []).map((f) => [f.name, f]));

  function walk(n) {
    if (!n) return () => true;
    if (n.kind === 'rule') {
      if (!n.field) return () => true;
      const fn = compileRule(n, byName);
      return n.not ? (p) => !fn(p) : fn;
    }
    const children = (n.rules ?? []).map(walk);
    if (children.length === 0) return () => true;

    let fn;
    if (n.op === 'OR') {
      fn = (p) => { for (const c of children) if (c(p)) return true; return false; };
    } else {
      fn = (p) => { for (const c of children) if (!c(p)) return false; return true; };
    }
    return n.not ? (p) => !fn(p) : fn;
  }
  return walk(node);
}

/**
 * Terapkan predikat ke FeatureCollection.
 * Mengembalikan bitmask, bukan array fitur baru: untuk 20.000 poligon,
 * bitmask memakan 20 kB sedangkan salinan fitur bisa puluhan MB.
 */
export function applyQuery(featureCollection, predicate) {
  const feats = featureCollection?.features ?? [];
  const mask = new Uint8Array(feats.length);
  let matched = 0;
  for (let i = 0; i < feats.length; i++) {
    if (predicate(feats[i].properties ?? {})) { mask[i] = 1; matched++; }
  }
  return { mask, matched, total: feats.length };
}

/**
 * Terjemahkan pohon menjadi kalimat mirip SQL — untuk ditampilkan ke pengguna
 * dan disimpan bersama hasil validasi sebagai jejak metodologi. Reviewer jurnal
 * akan menanyakan kriteria seleksi sampel; string ini adalah jawabannya.
 */
export function queryToSQL(node) {
  function walk(n) {
    if (!n) return '';
    if (n.kind === 'rule') {
      if (!n.field) return '';
      const f = `"${n.field}"`;
      const v = (x) => (typeof x === 'number' ? String(x) : `'${String(x).replace(/'/g, "''")}'`);
      let s;
      switch (n.operator) {
        case 'isNull': s = `${f} IS NULL`; break;
        case 'notNull': s = `${f} IS NOT NULL`; break;
        case 'contains': s = `${f} LIKE '%${n.value}%'`; break;
        case 'startsWith': s = `${f} LIKE '${n.value}%'`; break;
        case 'between': s = `${f} BETWEEN ${v(n.value)} AND ${v(n.value2)}`; break;
        case 'in': {
          const list = (Array.isArray(n.value) ? n.value : String(n.value).split(','))
            .map((x) => v(String(x).trim()));
          s = `${f} IN (${list.join(', ')})`;
          break;
        }
        default: s = `${f} ${n.operator} ${v(n.value)}`;
      }
      return n.not ? `NOT (${s})` : s;
    }
    const parts = (n.rules ?? []).map(walk).filter(Boolean);
    if (!parts.length) return '';
    const joined = parts.join(` ${n.op} `);
    const wrapped = parts.length > 1 ? `(${joined})` : joined;
    return n.not ? `NOT ${wrapped}` : wrapped;
  }
  return walk(node) || 'TRUE';
}

/** Statistik ringkas untuk satu kolom pada himpunan terpilih. */
export function summarizeField(featureCollection, mask, fieldName, type) {
  const feats = featureCollection?.features ?? [];
  if (type === FIELD_TYPES.NUMBER) {
    const vals = [];
    for (let i = 0; i < feats.length; i++) {
      if (!mask[i]) continue;
      const v = asNum(feats[i].properties?.[fieldName]);
      if (v !== null) vals.push(v);
    }
    if (!vals.length) return { count: 0 };
    vals.sort((a, b) => a - b);
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      count: vals.length,
      min: vals[0],
      max: vals[vals.length - 1],
      mean: sum / vals.length,
      median: vals[Math.floor(vals.length / 2)],
    };
  }
  const counts = new Map();
  for (let i = 0; i < feats.length; i++) {
    if (!mask[i]) continue;
    const k = String(feats[i].properties?.[fieldName] ?? '(kosong)');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {
    count: [...counts.values()].reduce((a, b) => a + b, 0),
    categories: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}
