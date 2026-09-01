/**
 * core/vector/style.js
 * ---------------------------------------------------------------------------
 * Pewarnaan fitur berdasarkan nilai atribut (symbology kategorikal).
 *
 * Padanan "Unique Values" di ArcGIS: pilih satu kolom, tiap nilai unik
 * mendapat warnanya sendiri.
 *
 * PALET DIPILIH, BUKAN DIACAK
 * ---------------------------
 * Warna acak menghasilkan pasangan yang tidak dapat dibedakan, dan berubah
 * setiap kali berkas dimuat ulang — sehingga peta hari ini tidak cocok dengan
 * tangkapan layar kemarin. Palet di bawah ini kualitatif, urutannya tetap,
 * dan dua belas warna pertamanya dapat dibedakan oleh sebagian besar bentuk
 * buta warna merah-hijau.
 *
 * Pemetaan dikunci ke urutan nilai yang terurut, bukan urutan kemunculan,
 * supaya hasilnya sama setiap kali berkas yang sama dibuka.
 */

export const PALETTE = [
  '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2',
  '#edc948', '#ff9da7', '#9c755f', '#bab0ac', '#1f77b4', '#8c564b',
];

/** Warna untuk fitur yang nilainya kosong atau di luar daftar. */
export const OTHER_COLOR = '#8a9990';

/**
 * Kumpulkan nilai unik satu kolom beserta jumlah fiturnya.
 * @returns {Array<{value:string, count:number}>} terurut menurun berdasar jumlah
 */
export function uniqueValues(fc, field, { max = 60 } = {}) {
  const counts = new Map();
  for (const f of fc?.features ?? []) {
    const raw = f.properties?.[field];
    const v = raw === null || raw === undefined || raw === '' ? '' : String(raw);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, max);
}

/**
 * Bangun pemetaan nilai -> warna.
 * Warna ditetapkan menurut urutan alfabetis nilai, bukan urutan kemunculan,
 * supaya berkas yang sama selalu menghasilkan peta yang sama.
 */
export function buildColorMap(values, existing = {}) {
  const sorted = [...values].map((v) => (typeof v === 'string' ? v : v.value)).sort();
  const map = {};
  sorted.forEach((v, i) => {
    map[v] = existing[v] ?? PALETTE[i % PALETTE.length];
  });
  return map;
}

/**
 * Gaya Leaflet untuk satu fitur.
 *
 * @param {object} props properti fitur
 * @param {object} cfg { field, colors, opacity, weight, dimmed }
 */
export function styleFor(props, cfg) {
  const { field, colors, fillOpacity = 0.45, weight = 1.5, dimmed = false } = cfg ?? {};

  // Kelas yang dimatikan dari legenda tidak digambar sama sekali.
  if (isClassHidden(props, cfg)) {
    return { stroke: false, fill: false, interactive: false };
  }
  if (dimmed) {
    return {
      color: OTHER_COLOR, weight: 1, opacity: 0.25,
      fillColor: OTHER_COLOR, fillOpacity: 0.04,
    };
  }
  if (!field) {
    return {
      color: '#ff2e88', weight, opacity: 0.95,
      fillColor: '#ff2e88', fillOpacity: 0.18,
    };
  }
  const raw = props?.[field];
  const key = raw === null || raw === undefined || raw === '' ? '' : String(raw);
  const c = colors?.[key] ?? OTHER_COLOR;
  return { color: c, weight, opacity: 0.95, fillColor: c, fillOpacity };
}

/** Entri legenda siap tampil. */
export function legendEntries(fc, field, colors) {
  if (!field) return [];
  return uniqueValues(fc, field).map(({ value, count }) => ({
    value,
    label: value === '' ? '(kosong)' : value,
    color: colors?.[value] ?? OTHER_COLOR,
    count,
  }));
}

/**
 * Kelas yang dimatikan dari legenda.
 *
 * Fitur TIDAK dihapus dari data, hanya tidak digambar. Mematikan lalu
 * menyalakannya kembali harus terasa gratis — bila datanya benar-benar
 * dibuang, menyalakannya kembali berarti memuat ulang berkas.
 */
export function isClassHidden(props, cfg) {
  const { field, classOff } = cfg ?? {};
  if (!field || !classOff) return false;
  const raw = props?.[field];
  const key = raw === null || raw === undefined || raw === '' ? '' : String(raw);
  return classOff[key] === true;
}
