/**
 * Apps_Script_REIS.gs
 * ---------------------------------------------------------------------------
 * Penerima data REIS untuk Google Sheets.
 *
 * CARA MEMASANG
 * 1. Buka spreadsheet tujuan → Extensions → Apps Script.
 * 2. Hapus isi Code.gs, tempel seluruh berkas ini.
 * 3. Ubah TOKEN di bawah menjadi kata sandi acak Anda sendiri.
 * 4. Jalankan fungsi siapkanSekarang() sekali. Google akan meminta izin —
 *    setujui. Log akan mencetak nama lembar dan folder foto yang dibuat.
 * 5. Deploy → New deployment → Web app.
 *      Execute as        : Me
 *      Who has access    : Anyone          ← WAJIB, bukan "Anyone with Google account"
 * 6. Salin URL yang berakhiran /exec ke tab Pengaturan di REIS.
 *
 * CATATAN KEAMANAN YANG JUJUR
 * "Anyone" berarti siapa pun yang tahu URL-nya dapat mengirim permintaan.
 * Token-lah satu-satunya penjaga. Perlakukan URL dan token seperti kata sandi:
 * jangan diunggah ke repositori publik, jangan disebar di grup terbuka.
 * Bila bocor, cukup ubah TOKEN di sini lalu Deploy ulang — URL lama akan
 * menolak seluruh pengiriman berikutnya.
 */

const TOKEN = 'ganti-dengan-kata-sandi-acak-anda';
const NAMA_LEMBAR = 'Titik REIS';
const NAMA_FOLDER = 'Foto REIS';

/** Urutan kolom. Menambah kolom baru: tambahkan di AKHIR daftar ini. */
const KOLOM = [
  'id', 'nama', 'lintang', 'bujur', 'kelas_peta', 'kelas_lapangan',
  'sesuai', 'sumber', 'akurasi_m', 'akurasi_ditandai', 'catatan',
  'surveyor', 'waktu', 'jumlah_foto', 'tautan_foto', 'diterima',
];

function siapkanSekarang() {
  const lembar = ambilLembar_();
  const folder = ambilFolder_();
  Logger.log('Lembar siap : ' + lembar.getParent().getUrl());
  Logger.log('Folder foto : ' + folder.getUrl());
  Logger.log('Setelah ini, lakukan Deploy → Web app → Who has access: Anyone.');
}

function ambilLembar_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(NAMA_LEMBAR);
  if (!sh) {
    sh = ss.insertSheet(NAMA_LEMBAR);
    sh.appendRow(KOLOM);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, KOLOM.length).setFontWeight('bold');
  }
  return sh;
}

function ambilFolder_() {
  const it = DriveApp.getFoldersByName(NAMA_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(NAMA_FOLDER);
}

/** Peta id → nomor baris, supaya upsert tidak memindai ulang tiap baris. */
function petaBaris_(sh) {
  const n = sh.getLastRow();
  const peta = {};
  if (n < 2) return peta;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i][0]);
    if (id) peta[id] = i + 2;
  }
  return peta;
}

function simpanFoto_(folder, id, daftarDataUrl) {
  const tautan = [];
  for (let i = 0; i < daftarDataUrl.length; i++) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(daftarDataUrl[i]);
    if (!m) continue;
    const blob = Utilities.newBlob(
      Utilities.base64Decode(m[2]), m[1], id + '_' + (i + 1) + '.jpg');
    const berkas = folder.createFile(blob);
    berkas.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    tautan.push(berkas.getUrl());
  }
  return tautan;
}

function doPost(e) {
  // Kunci skrip mencegah dua pengiriman bersamaan menulis di baris yang sama.
  // Tanpa ini, dua surveyor yang menekan simpan pada detik yang sama dapat
  // saling menimpa.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return balas_({ error: 'Server sedang sibuk, coba lagi.' });
  }

  try {
    const body = JSON.parse(e.postData.contents);

    if (body.token !== TOKEN) {
      return balas_({ error: 'Token tidak cocok.' });
    }

    const rows = body.rows || [];
    // Permintaan tanpa baris dipakai untuk Uji koneksi.
    if (!rows.length) {
      return balas_({ ok: true, pesan: 'Koneksi berhasil.', versi: 1 });
    }

    const sh = ambilLembar_();
    const folder = ambilFolder_();
    const peta = petaBaris_(sh);
    const sekarang = new Date();

    let diperbarui = 0;
    let ditambah = 0;
    let fotoTersimpan = 0;

    for (const r of rows) {
      const id = String(r.id || '');
      if (!id) continue;

      let tautanFoto = '';
      if (r.foto && r.foto.length) {
        const tautan = simpanFoto_(folder, id, r.foto);
        fotoTersimpan += tautan.length;
        tautanFoto = tautan.join('\n');
      }

      const baris = [
        id, r.nama || '', r.lintang, r.bujur, r.kelas_peta || '',
        r.kelas_lapangan || '', r.sesuai || '', r.sumber || '',
        r.akurasi_m === '' ? '' : r.akurasi_m, r.akurasi_ditandai || '',
        r.catatan || '', r.surveyor || '', r.waktu || '',
        r.jumlah_foto || 0, tautanFoto, sekarang,
      ];

      if (peta[id]) {
        const barisLama = sh.getRange(peta[id], 1, 1, KOLOM.length).getValues()[0];
        // Tautan foto yang sudah ada dipertahankan bila pengiriman kali ini
        // tidak menyertakan foto — jika tidak, foto lama akan hilang dari
        // lembar hanya karena kirim ulang tanpa foto.
        if (!tautanFoto) baris[14] = barisLama[14];
        sh.getRange(peta[id], 1, 1, KOLOM.length).setValues([baris]);
        diperbarui++;
      } else {
        sh.appendRow(baris);
        ditambah++;
      }
    }

    return balas_({
      ok: true, ditambah: ditambah, diperbarui: diperbarui,
      foto: fotoTersimpan, total: rows.length,
    });
  } catch (err) {
    return balas_({ error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

/** Permintaan GET dipakai untuk memeriksa Web App hidup dari peramban. */
function doGet() {
  return balas_({ ok: true, pesan: 'REIS Web App aktif. Kirim data lewat POST.' });
}

function balas_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
