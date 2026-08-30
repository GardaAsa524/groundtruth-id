/**
 * test/export.test.mjs — memeriksa berkas keluaran benar-benar sah.
 *
 * Uji ini membongkar ulang arsip yang dihasilkan dan membaca isinya, bukan
 * sekadar memeriksa fungsinya tidak melempar galat. Untuk penulis ZIP buatan
 * sendiri, itu perbedaan yang menentukan: arsip yang rusak tetap terbentuk
 * tanpa keluhan apa pun, dan baru ketahuan ketika Google Earth menolaknya.
 */
import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { inflateSync } from 'node:zlib';

globalThis.Blob = Blob;
globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
Object.defineProperty(globalThis, 'navigator',
  { value: { userAgent: 'node' }, configurable: true });

const { makeZip, crc32, dataURLToBytes } = await import('../src/core/export/zip.js');
const { exportKML, exportSamplesGeoJSON, esc } = await import('../src/core/export/kml.js');
const { makeXLSX, colName, safeSheetName } = await import('../src/core/export/xlsx.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** Pembaca ZIP mandiri: membongkar arsip tanpa memakai kode penulisnya. */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Cari End of Central Directory dari belakang.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD tidak ditemukan — arsip rusak');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('header pusat rusak');
    const crc = dv.getUint32(ptr + 16, true);
    const size = dv.getUint32(ptr + 24, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const cmtLen = dv.getUint16(ptr + 32, true);
    const local = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));

    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`header lokal rusak: ${name}`);
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + size);
    out.set(name, { data, crc });
    ptr += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const SAMPLES = [
  { id: 's1', name: 'CP-01 <asbes> & "atap"', lat: -6.874468, lon: 107.562790,
    predicted: 'Asbes', actual: 'Asbes', isCorrect: true, source: 'crosshair',
    photos: [JPG], note: 'uji & lolosan', timestamp: '2026-08-29T09:00:00Z' },
  { id: 's2', name: 'CP-02', lat: -6.875, lon: 107.563,
    predicted: 'Mangga', actual: 'Pisang', isCorrect: false, source: 'gps',
    accuracy: 4.2, photos: [JPG, JPG], note: '', timestamp: '2026-08-29T09:05:00Z' },
];

console.log('\n== penulis ZIP ==');
t('CRC32 cocok dengan nilai rujukan', () => {
  // CRC32 dari "123456789" adalah 0xCBF43926, konstanta baku.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
t('arsip dapat dibongkar ulang dan isinya utuh', async () => {});
{
  const blob = makeZip([
    { name: 'a.txt', data: 'halo dunia' },
    { name: 'folder/b — ê.txt', data: 'nama berkas non-ASCII' },
  ]);
  const buf = await bytesOf(blob);
  const z = readZip(buf);
  t('dua entri terbaca kembali', () => assert.equal(z.size, 2));
  t('isi berkas identik', () =>
    assert.equal(new TextDecoder().decode(z.get('a.txt').data), 'halo dunia'));
  t('nama berkas UTF-8 tidak rusak', () =>
    assert.ok(z.has('folder/b — ê.txt'), [...z.keys()].join(', ')));
  t('CRC tersimpan cocok dengan isi', () => {
    for (const [name, e] of z) assert.equal(crc32(e.data), e.crc, name);
  });
}

console.log('\n== KMZ / KML ==');
{
  const r = exportKML(SAMPLES);
  t('menghasilkan KMZ ketika ada foto', () => assert.equal(r.kind, 'kmz'));
  t('menghitung jumlah foto dengan benar', () => assert.equal(r.photos, 3));

  const z = readZip(await bytesOf(r.blob));
  const kml = new TextDecoder().decode(z.get('doc.kml').data);

  t('doc.kml ada di akar arsip', () => assert.ok(z.has('doc.kml')));
  t('setiap foto tersimpan sebagai JPEG sungguhan', () => {
    for (const n of ['files/s1_1.jpg', 'files/s2_1.jpg', 'files/s2_2.jpg']) {
      const d = z.get(n);
      assert.ok(d, `${n} tidak ada`);
      assert.deepEqual(Array.from(d.data.subarray(0, 3)), [0xff, 0xd8, 0xff], n);
    }
  });
  t('koordinat ditulis lon,lat sesuai spesifikasi KML', () => {
    const m = kml.match(/<coordinates>([^<]+)<\/coordinates>/);
    const [lon, lat] = m[1].split(',').map(Number);
    assert.ok(Math.abs(lon - 107.56279) < 1e-6, `lon ${lon}`);
    assert.ok(Math.abs(lat + 6.874468) < 1e-6, `lat ${lat}`);
  });
  t('karakter XML khusus dilolosi pada nama', () => {
    assert.ok(kml.includes('CP-01 &lt;asbes&gt;'), 'nama tidak dilolosi');
    assert.ok(!/<name>CP-01 <asbes>/.test(kml));
  });
  t('balon merujuk foto dengan jalur relatif di dalam arsip', () => {
    assert.ok(kml.includes('files/s1_1.jpg'));
  });
  t('hanya foto pertama yang ditampilkan di balon', () => {
    assert.equal((kml.match(/<img/g) ?? []).length, 2, 'satu img per titik berfoto');
  });

  const noPhoto = exportKML(SAMPLES.map((s) => ({ ...s, photos: [] })));
  t('menghasilkan KML biasa ketika tidak ada foto', () => {
    assert.equal(noPhoto.kind, 'kml');
    assert.ok(noPhoto.filename.endsWith('.kml'));
  });
}

console.log('\n== GeoJSON titik ==');
{
  const g = exportSamplesGeoJSON(SAMPLES);
  const text = await g.blob.text();
  const fc = JSON.parse(text);
  t('struktur FeatureCollection benar', () => {
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 2);
    assert.equal(fc.features[0].geometry.type, 'Point');
  });
  t('koordinat lon,lat sesuai RFC 7946', () => {
    assert.ok(Math.abs(fc.features[0].geometry.coordinates[0] - 107.56279) < 1e-6);
  });
  t('foto tidak disematkan — berkas tetap kecil', () => {
    assert.ok(!text.includes('base64'), 'base64 bocor ke GeoJSON');
    assert.ok(text.length < 4000, `${text.length} bita terlalu besar`);
  });
  t('jumlah foto tetap tercatat sebagai atribut', () => {
    assert.equal(fc.features[1].properties.jumlah_foto, 2);
  });
}

console.log('\n== penulis XLSX ==');
t('nama kolom Excel benar melewati batas Z', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(27), 'AB');
});
t('nama lembar dibersihkan dari karakter terlarang', () => {
  assert.equal(safeSheetName('Data/Uji:2026'), 'Data-Uji-2026');
  assert.equal(safeSheetName('x'.repeat(40)).length, 31);
  assert.equal(safeSheetName(''), 'Sheet');
});
{
  const blob = makeXLSX([
    { name: 'Uji', rows: [['Teks', 'Angka'], ['baris', 0.8667], ['kosong', null]] },
  ]);
  const z = readZip(await bytesOf(blob));
  t('bagian wajib OOXML lengkap', () => {
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                     'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
      assert.ok(z.has(n), `${n} hilang`);
    }
  });
  const sheet = new TextDecoder().decode(z.get('xl/worksheets/sheet1.xml').data);
  t('angka ditulis sebagai <v>, bukan teks', () => {
    assert.ok(sheet.includes('<v>0.8667</v>'), 'angka tidak tersimpan sebagai numerik');
  });
  t('teks ditulis sebagai inlineStr', () => {
    assert.ok(sheet.includes('t="inlineStr"'));
  });
  t('sel kosong ditulis sebagai sel kosong, bukan nol', () => {
    assert.ok(/<c r="B3"\/>/.test(sheet), 'null seharusnya menjadi sel kosong');
  });
  t('rujukan sel memakai alamat A1 yang benar', () => {
    assert.ok(sheet.includes('r="A1"') && sheet.includes('r="B2"'));
  });
}

console.log('\n== data URL ==');
t('data URL base64 dibongkar dengan benar', () => {
  const r = dataURLToBytes(JPG);
  assert.equal(r.ext, 'jpg');
  assert.deepEqual(Array.from(r.bytes.subarray(0, 3)), [0xff, 0xd8, 0xff]);
});
t('data URL tidak sah ditolak, bukan menghasilkan sampah', () => {
  assert.equal(dataURLToBytes('bukan data url'), null);
  assert.equal(dataURLToBytes(undefined), null);
});
t('lolosan XML menangani seluruh karakter khusus', () => {
  assert.equal(esc('<a & "b" \'c\'>'), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
});

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
