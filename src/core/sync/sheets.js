/**
 * core/sync/sheets.js
 * ---------------------------------------------------------------------------
 * Pengiriman titik validasi ke Google Sheets lewat Apps Script Web App.
 *
 * MENGAPA APPS SCRIPT, BUKAN GOOGLE SHEETS API LANGSUNG
 * -----------------------------------------------------
 * Sheets API resmi memerlukan OAuth: alur persetujuan, penyegaran token, dan
 * client secret yang tidak boleh berada di dalam aplikasi sisi klien. Untuk
 * aplikasi lapangan yang dipakai beberapa surveyor pada perangkat masing-masing,
 * itu berlebihan dan justru menaruh rahasia di tempat yang tidak aman.
 *
 * Apps Script Web App menyelesaikannya dengan sederhana: satu URL, satu token
 * bersama, berjalan atas nama pemilik spreadsheet. Rahasianya cuma token, dan
 * cakupan kerusakannya bila bocor hanya menulis ke satu spreadsheet — bukan
 * seluruh akun Google.
 *
 * TIGA HAL YANG MEMBUATNYA BEKERJA DI LAPANGAN
 * --------------------------------------------
 * 1. Antrean luring. Sinyal di lapangan putus-putus; pengiriman yang gagal
 *    tidak boleh menghilangkan data maupun menghalangi perekaman berikutnya.
 * 2. Upsert, bukan append. Titik yang sama dikirim ulang setelah gagal harus
 *    memperbarui barisnya, bukan menambah baris kembar. Kuncinya id sampel.
 * 3. Foto dikirim terpisah dan hanya sekali. Base64 foto 300 kB melewati batas
 *    ukuran permintaan bila digabung banyak titik sekaligus.
 */

/** Status yang dapat dibaca antarmuka. */
export const SYNC = {
  OFF: 'off',            // belum dikonfigurasi
  IDLE: 'idle',          // tersambung, tidak ada antrean
  SENDING: 'sending',
  QUEUED: 'queued',      // ada yang menunggu jaringan
  ERROR: 'error',
};

const KEY = 'reis.sheets.config';
const QUEUE_KEY = 'reis.sheets.queue';

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : { url: '', token: '', sendPhotos: true, enabled: false };
  } catch {
    return { url: '', token: '', sendPhotos: true, enabled: false };
  }
}

export function saveConfig(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* mode privat */ }
}

/* ------------------------------------------------------------------ antrean */

export function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistQueue(q) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch (e) {
    // Kuota localStorage habis, hampir selalu karena foto. Antrean dipangkas
    // dari yang terlama supaya perekaman tetap bisa berjalan; data itu sendiri
    // tidak hilang karena tetap ada di daftar sampel aplikasi.
    console.warn('Antrean sinkron dipangkas, kuota penyimpanan penuh:', e.message);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-25))); } catch { /* menyerah */ }
  }
}

/**
 * Masukkan sampel ke antrean. Upsert: satu id hanya boleh punya satu entri.
 * Entri lama diganti seluruhnya, karena isian yang belakangan selalu lebih
 * benar daripada yang lebih dulu.
 */
export function enqueue(queue, sample) {
  const next = queue.filter((q) => q.id !== sample.id);
  next.push(sample);
  persistQueue(next);
  return next;
}

export function dequeue(queue, ids) {
  const set = new Set(ids);
  const next = queue.filter((q) => !set.has(q.id));
  persistQueue(next);
  return next;
}

/* ------------------------------------------------------------- muatan kirim */

/**
 * Ubah sampel menjadi baris yang dikirim.
 * Kolomnya sengaja datar dan bernama tetap, supaya lembar tujuannya stabil
 * walau versi aplikasi berubah.
 */
export function toRow(s, { includePhotos = true } = {}) {
  return {
    id: s.id,
    nama: s.name ?? '',
    lintang: s.lat,
    bujur: s.lon,
    kelas_peta: s.predicted ?? '',
    kelas_lapangan: s.actual ?? '',
    sesuai: s.isCorrect ? 'Sesuai' : 'Tidak sesuai',
    sumber: s.source === 'gps' ? 'GPS' : 'Crosshair',
    akurasi_m: Number.isFinite(s.accuracy) ? Number(s.accuracy.toFixed(2)) : '',
    akurasi_ditandai: s.accuracyFlagged ? 'Ya' : 'Tidak',
    catatan: s.note ?? '',
    surveyor: s.surveyor ?? '',
    waktu: s.timestamp ?? '',
    jumlah_foto: (s.photos ?? []).length,
    // Foto hanya disertakan bila diminta DAN belum pernah terkirim. Mengirim
    // ulang foto pada tiap percobaan adalah cara tercepat menghabiskan kuota
    // data surveyor.
    foto: includePhotos && !s.photosSent ? (s.photos ?? []) : [],
  };
}

/**
 * Kirim satu kelompok baris.
 *
 * Memakai Content-Type text/plain dengan sengaja. Apps Script tidak
 * mengembalikan header CORS untuk permintaan preflight, dan
 * application/json memicu preflight. text/plain termasuk permintaan
 * sederhana, sehingga peramban mengirimnya langsung tanpa OPTIONS.
 * Isinya tetap JSON; Apps Script mengurai e.postData.contents sendiri.
 */
export async function sendBatch(config, rows, { signal, timeoutMs = 30000 } = {}) {
  if (!config?.url) throw new Error('Alamat Web App belum diisi.');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ac.abort());

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: config.token, rows }),
      signal: ac.signal,
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`Server menjawab ${res.status}`);

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Apps Script mengembalikan halaman HTML masuk ketika Web App tidak
      // disetel "Siapa saja". Ini kekeliruan konfigurasi paling sering, dan
      // pesan bawaannya sama sekali tidak menjelaskan sebabnya.
      if (/<html/i.test(text)) {
        throw new Error(
          'Server mengembalikan halaman masuk Google, bukan data. Pada Apps Script, ' +
          'setel Deploy → Web app → Who has access menjadi "Anyone".'
        );
      }
      throw new Error('Jawaban server tidak dapat dibaca.');
    }

    if (json.error) throw new Error(json.error);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Uji koneksi tanpa menulis data. */
export async function testConnection(config) {
  const r = await sendBatch(config, [], { timeoutMs: 15000 });
  return r;
}

/**
 * Pecah antrean menjadi kelompok yang muat dalam satu permintaan.
 *
 * Batas Apps Script sekitar 50 MB, tetapi jaringan lapangan jauh lebih
 * membatasi: satu permintaan 5 MB pada sinyal 3G lemah memerlukan menit dan
 * sering putus di tengah. Kelompok dibatasi ukuran, bukan jumlah baris,
 * karena satu titik berfoto bisa 60 kali lebih besar dari titik tanpa foto.
 */
export function chunkQueue(rows, { maxBytes = 3.5e6, maxRows = 50 } = {}) {
  const out = [];
  let cur = [];
  let size = 0;

  for (const r of rows) {
    const b = JSON.stringify(r).length;
    // Satu baris yang sendirian melebihi batas tetap dikirim sendirian —
    // memotongnya akan merusak data, dan menolaknya membuatnya tidak pernah
    // terkirim sama sekali.
    if (cur.length && (size + b > maxBytes || cur.length >= maxRows)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += b;
  }
  if (cur.length) out.push(cur);
  return out;
}
