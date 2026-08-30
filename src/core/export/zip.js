/**
 * core/export/zip.js
 * ---------------------------------------------------------------------------
 * Penulis arsip ZIP minimal (metode "store", tanpa kompresi).
 *
 * MENGAPA MENULIS SENDIRI
 * -----------------------
 * KMZ dan XLSX keduanya arsip ZIP. Memakai JSZip berarti menambah ~100 kB
 * tergzip ke bundel yang harus diunduh setiap surveyor, hanya untuk membuat
 * dua jenis berkas keluaran. Penulis di bawah ini 120 baris dan menangani
 * persis yang diperlukan.
 *
 * Metode "store" dipilih dengan sadar. Isi KMZ didominasi foto JPEG yang sudah
 * termampat; memampatkannya lagi hanya menghabiskan waktu CPU di ponsel tanpa
 * mengurangi ukuran. Untuk XLSX yang isinya teks, berkasnya memang lebih besar
 * dari seharusnya, tetapi tabel uji akurasi berukuran puluhan kilobita —
 * selisihnya tidak berarti.
 *
 * Nama berkas ditulis sebagai UTF-8 dengan bendera bahasa umum bit 11 dinyalakan,
 * supaya nama berbahasa Indonesia dengan tanda baca tidak rusak saat dibuka.
 */

/* --------------------------------------------------------------------- CRC32 */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ penulis */

const enc = new TextEncoder();

/** Waktu berkas dalam format DOS yang dipakai ZIP. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) |
    (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

class ByteWriter {
  constructor() { this.parts = []; this.length = 0; }
  push(u8) { this.parts.push(u8); this.length += u8.length; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  blob(type) { return new Blob(this.parts, { type }); }
}

/**
 * Bangun arsip ZIP.
 *
 * @param {Array<{name:string, data:Uint8Array|string}>} files
 * @param {string} mime tipe MIME untuk Blob keluaran
 * @returns {Blob}
 */
export function makeZip(files, mime = 'application/zip') {
  const w = new ByteWriter();
  const central = [];
  const { time, date } = dosTime();

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const offset = w.length;

    // --- local file header ---
    w.u32(0x04034b50);
    w.u16(20);            // versi minimum
    w.u16(0x0800);        // bendera: nama berkas UTF-8
    w.u16(0);             // metode: store
    w.u16(time);
    w.u16(date);
    w.u32(crc);
    w.u32(data.length);   // ukuran termampat
    w.u32(data.length);   // ukuran asli
    w.u16(nameBytes.length);
    w.u16(0);             // panjang extra field
    w.push(nameBytes);
    w.push(data);

    central.push({ nameBytes, crc, size: data.length, offset });
  }

  const centralStart = w.length;
  for (const c of central) {
    w.u32(0x02014b50);
    w.u16(20);            // versi pembuat
    w.u16(20);            // versi minimum
    w.u16(0x0800);
    w.u16(0);
    w.u16(time);
    w.u16(date);
    w.u32(c.crc);
    w.u32(c.size);
    w.u32(c.size);
    w.u16(c.nameBytes.length);
    w.u16(0);             // extra
    w.u16(0);             // komentar
    w.u16(0);             // nomor cakram
    w.u16(0);             // atribut internal
    w.u32(0);             // atribut eksternal
    w.u32(c.offset);
    w.push(c.nameBytes);
  }
  const centralSize = w.length - centralStart;

  // --- end of central directory ---
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(central.length);
  w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);

  return w.blob(mime);
}

/** Ubah data URL menjadi { bytes, ext } untuk dimasukkan ke arsip. */
export function dataURLToBytes(dataURL) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataURL ?? '');
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const isB64 = !!m[2];
  const body = m[3];

  let bytes;
  if (isB64) {
    const bin = atob(body);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = enc.encode(decodeURIComponent(body));
  }
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  return { bytes, mime, ext };
}

/** Unduh Blob ke penyimpanan lokal, dengan jalur Web Share untuk iOS. */
export async function downloadBlob(blob, filename) {
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare?.({ files: [file] }) && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: filename });
      return { ok: true, via: 'share' };
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, cancelled: true };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  return { ok: true, via: 'anchor', bytes: blob.size };
}
