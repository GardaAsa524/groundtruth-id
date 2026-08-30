/**
 * core/sync/appsScript.js
 * ---------------------------------------------------------------------------
 * Kode Apps Script disimpan sebagai teks di dalam aplikasi.
 *
 * MENGAPA DITANAM, BUKAN DITAUTKAN
 * --------------------------------
 * Pemasangan sinkronisasi dilakukan sekali oleh pengelola data, sering kali
 * dari ponsel di lapangan, dan hampir selalu pada momen ketika ia tidak
 * memegang berkas proyek. Menautkan ke berkas .gs di repositori berarti
 * meminta orang membuka GitHub, mencari berkasnya, lalu menyalin dari tampilan
 * kode — tiga langkah yang mudah gagal di layar kecil.
 *
 * Menanamnya di sini membuat seluruh pemasangan selesai dalam satu tab:
 * salin, tempel, deploy.
 *
 * Token contoh sengaja berupa penanda yang diganti saat ditampilkan, supaya
 * tidak ada dua pemasangan yang tanpa sadar memakai token yang sama.
 */

/** Kode sumber Apps Script, dengan __TOKEN__ sebagai penanda pengganti. */
export const APPS_SCRIPT_TEMPLATE = "/**\n * Apps_Script_REIS.gs\n * ---------------------------------------------------------------------------\n * Penerima data REIS untuk Google Sheets.\n *\n * CARA MEMASANG\n * 1. Buka spreadsheet tujuan \u2192 Extensions \u2192 Apps Script.\n * 2. Hapus isi Code.gs, tempel seluruh berkas ini.\n * 3. Ubah TOKEN di bawah menjadi kata sandi acak Anda sendiri.\n * 4. Jalankan fungsi siapkanSekarang() sekali. Google akan meminta izin \u2014\n *    setujui. Log akan mencetak nama lembar dan folder foto yang dibuat.\n * 5. Deploy \u2192 New deployment \u2192 Web app.\n *      Execute as        : Me\n *      Who has access    : Anyone          \u2190 WAJIB, bukan \"Anyone with Google account\"\n * 6. Salin URL yang berakhiran /exec ke tab Pengaturan di REIS.\n *\n * CATATAN KEAMANAN YANG JUJUR\n * \"Anyone\" berarti siapa pun yang tahu URL-nya dapat mengirim permintaan.\n * Token-lah satu-satunya penjaga. Perlakukan URL dan token seperti kata sandi:\n * jangan diunggah ke repositori publik, jangan disebar di grup terbuka.\n * Bila bocor, cukup ubah TOKEN di sini lalu Deploy ulang \u2014 URL lama akan\n * menolak seluruh pengiriman berikutnya.\n */\n\nconst TOKEN = '__TOKEN__';\nconst NAMA_LEMBAR = 'Titik REIS';\nconst NAMA_FOLDER = 'Foto REIS';\n\n/** Urutan kolom. Menambah kolom baru: tambahkan di AKHIR daftar ini. */\nconst KOLOM = [\n  'id', 'nama', 'lintang', 'bujur', 'kelas_peta', 'kelas_lapangan',\n  'sesuai', 'sumber', 'akurasi_m', 'akurasi_ditandai', 'catatan',\n  'surveyor', 'waktu', 'jumlah_foto', 'tautan_foto', 'diterima',\n];\n\nfunction siapkanSekarang() {\n  const lembar = ambilLembar_();\n  const folder = ambilFolder_();\n  Logger.log('Lembar siap : ' + lembar.getParent().getUrl());\n  Logger.log('Folder foto : ' + folder.getUrl());\n  Logger.log('Setelah ini, lakukan Deploy \u2192 Web app \u2192 Who has access: Anyone.');\n}\n\nfunction ambilLembar_() {\n  const ss = SpreadsheetApp.getActiveSpreadsheet();\n  let sh = ss.getSheetByName(NAMA_LEMBAR);\n  if (!sh) {\n    sh = ss.insertSheet(NAMA_LEMBAR);\n    sh.appendRow(KOLOM);\n    sh.setFrozenRows(1);\n    sh.getRange(1, 1, 1, KOLOM.length).setFontWeight('bold');\n  }\n  return sh;\n}\n\nfunction ambilFolder_() {\n  const it = DriveApp.getFoldersByName(NAMA_FOLDER);\n  return it.hasNext() ? it.next() : DriveApp.createFolder(NAMA_FOLDER);\n}\n\n/** Peta id \u2192 nomor baris, supaya upsert tidak memindai ulang tiap baris. */\nfunction petaBaris_(sh) {\n  const n = sh.getLastRow();\n  const peta = {};\n  if (n < 2) return peta;\n  const ids = sh.getRange(2, 1, n - 1, 1).getValues();\n  for (let i = 0; i < ids.length; i++) {\n    const id = String(ids[i][0]);\n    if (id) peta[id] = i + 2;\n  }\n  return peta;\n}\n\nfunction simpanFoto_(folder, id, daftarDataUrl) {\n  const tautan = [];\n  for (let i = 0; i < daftarDataUrl.length; i++) {\n    const m = /^data:([^;]+);base64,(.*)$/.exec(daftarDataUrl[i]);\n    if (!m) continue;\n    const blob = Utilities.newBlob(\n      Utilities.base64Decode(m[2]), m[1], id + '_' + (i + 1) + '.jpg');\n    const berkas = folder.createFile(blob);\n    berkas.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);\n    tautan.push(berkas.getUrl());\n  }\n  return tautan;\n}\n\nfunction doPost(e) {\n  // Kunci skrip mencegah dua pengiriman bersamaan menulis di baris yang sama.\n  // Tanpa ini, dua surveyor yang menekan simpan pada detik yang sama dapat\n  // saling menimpa.\n  const lock = LockService.getScriptLock();\n  try {\n    lock.waitLock(30000);\n  } catch (err) {\n    return balas_({ error: 'Server sedang sibuk, coba lagi.' });\n  }\n\n  try {\n    const body = JSON.parse(e.postData.contents);\n\n    if (body.token !== TOKEN) {\n      return balas_({ error: 'Token tidak cocok.' });\n    }\n\n    const rows = body.rows || [];\n    // Permintaan tanpa baris dipakai untuk Uji koneksi.\n    if (!rows.length) {\n      return balas_({ ok: true, pesan: 'Koneksi berhasil.', versi: 1 });\n    }\n\n    const sh = ambilLembar_();\n    const folder = ambilFolder_();\n    const peta = petaBaris_(sh);\n    const sekarang = new Date();\n\n    let diperbarui = 0;\n    let ditambah = 0;\n    let fotoTersimpan = 0;\n\n    for (const r of rows) {\n      const id = String(r.id || '');\n      if (!id) continue;\n\n      let tautanFoto = '';\n      if (r.foto && r.foto.length) {\n        const tautan = simpanFoto_(folder, id, r.foto);\n        fotoTersimpan += tautan.length;\n        tautanFoto = tautan.join('\\n');\n      }\n\n      const baris = [\n        id, r.nama || '', r.lintang, r.bujur, r.kelas_peta || '',\n        r.kelas_lapangan || '', r.sesuai || '', r.sumber || '',\n        r.akurasi_m === '' ? '' : r.akurasi_m, r.akurasi_ditandai || '',\n        r.catatan || '', r.surveyor || '', r.waktu || '',\n        r.jumlah_foto || 0, tautanFoto, sekarang,\n      ];\n\n      if (peta[id]) {\n        const barisLama = sh.getRange(peta[id], 1, 1, KOLOM.length).getValues()[0];\n        // Tautan foto yang sudah ada dipertahankan bila pengiriman kali ini\n        // tidak menyertakan foto \u2014 jika tidak, foto lama akan hilang dari\n        // lembar hanya karena kirim ulang tanpa foto.\n        if (!tautanFoto) baris[14] = barisLama[14];\n        sh.getRange(peta[id], 1, 1, KOLOM.length).setValues([baris]);\n        diperbarui++;\n      } else {\n        sh.appendRow(baris);\n        ditambah++;\n      }\n    }\n\n    return balas_({\n      ok: true, ditambah: ditambah, diperbarui: diperbarui,\n      foto: fotoTersimpan, total: rows.length,\n    });\n  } catch (err) {\n    return balas_({ error: String(err && err.message ? err.message : err) });\n  } finally {\n    lock.releaseLock();\n  }\n}\n\n/** Permintaan GET dipakai untuk memeriksa Web App hidup dari peramban. */\nfunction doGet() {\n  return balas_({ ok: true, pesan: 'REIS Web App aktif. Kirim data lewat POST.' });\n}\n\nfunction balas_(obj) {\n  return ContentService\n    .createTextOutput(JSON.stringify(obj))\n    .setMimeType(ContentService.MimeType.JSON);\n}\n";

/**
 * Hasilkan token acak.
 *
 * Memakai crypto.getRandomValues, bukan Math.random. Token inilah satu-satunya
 * penjaga endpoint yang dapat diakses siapa pun yang tahu URL-nya, jadi
 * keacakannya harus benar-benar tidak dapat ditebak — Math.random tidak
 * memberikan jaminan itu.
 */
export function generateToken(bytes = 18) {
  const buf = new Uint8Array(bytes);
  (globalThis.crypto ?? globalThis.msCrypto).getRandomValues(buf);
  // base64url: aman dipakai di dalam string kode maupun di URL, tanpa karakter
  // yang perlu dilolosi.
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Kode siap salin, dengan token pengguna sudah tertanam. */
export function buildAppsScript(token) {
  const t = (token ?? '').trim() || generateToken();
  return APPS_SCRIPT_TEMPLATE.replaceAll('__TOKEN__', t);
}

/**
 * Salin ke papan klip.
 *
 * navigator.clipboard hanya tersedia pada konteks aman dan, di sebagian
 * peramban, hanya di dalam penangan ketukan pengguna. Jalur cadangan
 * execCommand tetap diperlukan; tanpanya, tombol salin gagal senyap di
 * sebagian ponsel Android lama.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: 'clipboard' };
    }
  } catch { /* jatuh ke jalur cadangan */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? { ok: true, via: 'execCommand' } : { ok: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
