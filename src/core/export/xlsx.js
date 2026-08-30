/**
 * core/export/xlsx.js
 * ---------------------------------------------------------------------------
 * Penulis XLSX minimal untuk laporan uji akurasi.
 *
 * MENGAPA XLSX DAN BUKAN CSV
 * --------------------------
 * CSV kehilangan tipe data: angka 0,8667 di Excel Indonesia terbaca sebagai
 * teks bila pemisah desimalnya berbeda dari pengaturan mesin. Untuk laporan
 * akurasi yang angkanya akan dihitung ulang atau dibuatkan grafik, itu masalah
 * nyata. XLSX menyimpan angka sebagai angka, terlepas dari pengaturan lokal.
 *
 * Alasan kedua: satu berkas dapat memuat beberapa lembar. Matriks konfusi,
 * metrik per kelas, dan daftar titik mentah adalah tiga tabel dengan bentuk
 * berbeda; memaksanya ke satu CSV membuat semuanya sulit dibaca.
 *
 * Penulis ini menghasilkan XLSX seminimal mungkin yang tetap sah: tanpa gaya,
 * tanpa rumus, tanpa tabel bernama. Excel, LibreOffice, dan Google Sheets
 * ketiganya membacanya.
 */

import { makeZip } from './zip.js';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Nama kolom Excel dari indeks nol: 0 -> A, 26 -> AA. */
export function colName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Nama lembar Excel punya batasan keras yang bila dilanggar membuat berkasnya
 * rusak tanpa pesan: maksimum 31 karakter, dan tidak boleh memuat : \ / ? * [ ]
 */
export function safeSheetName(name, fallback = 'Sheet') {
  const cleaned = String(name ?? '').replace(/[:\\/?*[\]]/g, '-').trim();
  return (cleaned || fallback).slice(0, 31);
}

function cellXML(ref, value) {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  // Teks ditulis inline supaya tidak perlu tabel string bersama.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXML(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => cellXML(`${colName(c)}${r + 1}`, v)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Bangun berkas XLSX.
 * @param {Array<{name:string, rows:Array<Array<string|number|null>>}>} sheets
 * @returns {Blob}
 */
export function makeXLSX(sheets) {
  const used = new Set();
  const names = sheets.map((s, i) => {
    let n = safeSheetName(s.name, `Sheet${i + 1}`);
    let k = 1;
    while (used.has(n.toLowerCase())) n = safeSheetName(`${n.slice(0, 28)}_${++k}`);
    used.add(n.toLowerCase());
    return n;
  });

  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) =>
  `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${names.map((n, i) =>
  `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) =>
  `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
).join('\n')}
</Relationships>`,
    },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXML(s.rows),
    })),
  ];

  return makeZip(
    files,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

/* ------------------------------------------------- buku kerja uji akurasi */

const r4 = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);

/**
 * Susun buku kerja lengkap untuk pelaporan.
 *
 * Tiga lembar dengan maksud berbeda:
 *   Matriks     — tabel silang mentah, yang diminta setiap laporan.
 *   Metrik      — OA, Kappa, F1, dan angka per kelas.
 *   Titik       — data mentah, supaya hasilnya dapat ditelusuri ulang.
 */
export function buildAccuracyWorkbook({ cm, metrics, samples, binary }) {
  const sheets = [];

  if (cm && metrics) {
    const { classes, matrix } = cm;
    const rows = [];
    rows.push(['Matriks konfusi — baris: kelas peta, kolom: kelas lapangan']);
    rows.push([]);
    rows.push(['Peta \\ Lapangan', ...classes, 'Total', "User's Accuracy"]);
    classes.forEach((c, i) => {
      const total = matrix[i].reduce((a, b) => a + b, 0);
      rows.push([c, ...Array.from(matrix[i], Number), total,
        r4(metrics.perClass[i]?.usersAccuracy)]);
    });
    rows.push(['Total',
      ...classes.map((_, j) => matrix.reduce((a, r) => a + r[j], 0)),
      metrics.total, null]);
    rows.push(["Producer's Accuracy",
      ...classes.map((_, j) => r4(metrics.perClass[j]?.producersAccuracy)), null, null]);
    sheets.push({ name: 'Matriks', rows });

    const m = [];
    m.push(['Metrik', 'Nilai', 'Keterangan']);
    m.push(['Overall Accuracy', r4(metrics.overallAccuracy),
      `CI 95%: ${r4(metrics.overallAccuracyCI95[0])} – ${r4(metrics.overallAccuracyCI95[1])}`]);
    m.push(['Koefisien Kappa', r4(metrics.kappa),
      'Sertakan bila diminta, tetapi jangan dijadikan metrik utama (Pontius & Millones 2011)']);
    m.push(['Galat baku Kappa', r4(metrics.kappaSE), '']);
    m.push(['Macro F1', r4(metrics.macroF1), 'Rerata F1 antar kelas, tidak berbobot']);
    m.push(['Micro F1', r4(metrics.microF1), 'Identik dengan OA pada klasifikasi satu-label']);
    m.push(['Jumlah sampel', metrics.total, '']);
    m.push([]);
    m.push(['Kelas', "User's Acc", "Producer's Acc", 'F1',
      'Galat komisi', 'Galat omisi', 'n dipetakan', 'n rujukan', 'n benar']);
    for (const c of metrics.perClass) {
      m.push([c.name, r4(c.usersAccuracy), r4(c.producersAccuracy), r4(c.f1),
        r4(c.commissionError), r4(c.omissionError), c.mapped, c.reference, c.correct]);
    }
    m.push([]);
    m.push(['Catatan metodologis']);
    m.push(['Overall Accuracy mentah hanya sahih pada sampel acak sederhana.']);
    m.push(['Bila sampel diambil berstrata per kelas peta, laporkan metrik terboboti luas (Olofsson et al. 2014).']);
    sheets.push({ name: 'Metrik', rows: m });
  } else if (binary) {
    const b = [['Validasi biner — hanya menghasilkan User\'s Accuracy'], []];
    b.push(['Kelas peta', 'n', 'Benar', "User's Accuracy", 'CI 95% bawah', 'CI 95% atas']);
    for (const c of binary.perClass) {
      b.push([c.name, c.n, c.correct, r4(c.usersAccuracy), r4(c.ci95[0]), r4(c.ci95[1])]);
    }
    b.push([]);
    b.push([binary.limitation]);
    sheets.push({ name: 'Validasi biner', rows: b });
  }

  const t = [[
    'ID', 'Nama titik', 'Lintang', 'Bujur', 'Kelas peta', 'Kelas lapangan',
    'Sesuai', 'Sumber', 'Akurasi (m)', 'Akurasi ditandai', 'Jumlah foto',
    'Catatan', 'Waktu',
  ]];
  for (const s of samples ?? []) {
    t.push([
      s.id, s.name ?? '', Number(s.lat.toFixed(7)), Number(s.lon.toFixed(7)),
      s.predicted ?? '', s.actual ?? '', s.isCorrect ? 'Sesuai' : 'Tidak sesuai',
      s.source === 'gps' ? 'GPS' : 'Crosshair',
      Number.isFinite(s.accuracy) ? Number(s.accuracy.toFixed(2)) : null,
      s.accuracyFlagged ? 'Ya' : 'Tidak',
      (s.photos ?? []).length, s.note ?? '', s.timestamp ?? '',
    ]);
  }
  sheets.push({ name: 'Titik', rows: t });

  return makeXLSX(sheets);
}
