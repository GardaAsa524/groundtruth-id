import assert from 'node:assert/strict';
let store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
const m = await import('../src/core/sync/sheets.js');
let pass=0, fail=0;
const t=(n,f)=>{try{f();console.log(`  ok   ${n}`);pass++}catch(e){console.log(`  FAIL ${n}\n       ${e.message}`);fail++}};

console.log('\n== antrean sinkron ==');
t('enqueue melakukan upsert, bukan menambah baris kembar', () => {
  let q = [];
  q = m.enqueue(q, { id: 'a', predicted: 'Sawah' });
  q = m.enqueue(q, { id: 'b', predicted: 'Kebun' });
  q = m.enqueue(q, { id: 'a', predicted: 'Terbangun' });
  assert.equal(q.length, 2);
  assert.equal(q.find((x) => x.id === 'a').predicted, 'Terbangun');
});
t('antrean bertahan lewat localStorage', () => {
  m.enqueue([], { id: 'z' });
  assert.equal(m.loadQueue().length, 1);
});
t('dequeue membuang hanya id yang berhasil terkirim', () => {
  let q = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  q = m.dequeue(q, ['a', 'c']);
  assert.deepEqual(q.map((x) => x.id), ['b']);
});

console.log('\n== muatan baris ==');
const S = { id: 's1', name: 'CP-01', lat: -6.87, lon: 107.56, predicted: 'Asbes',
  actual: 'Asbes', isCorrect: true, source: 'gps', accuracy: 4.234,
  photos: ['data:image/jpeg;base64,AAA'], timestamp: '2026-08-30T09:00:00Z' };
t('kolom baris lengkap dan bernama tetap', () => {
  const r = m.toRow(S);
  for (const k of ['id','nama','lintang','bujur','kelas_peta','kelas_lapangan',
                   'sesuai','sumber','akurasi_m','catatan','waktu','jumlah_foto'])
    assert.ok(k in r, `kolom ${k} hilang`);
  assert.equal(r.sesuai, 'Sesuai');
  assert.equal(r.akurasi_m, 4.23, 'akurasi dibulatkan dua desimal');
});
t('foto tidak dikirim ulang bila sudah pernah terkirim', () => {
  assert.equal(m.toRow(S).foto.length, 1);
  assert.equal(m.toRow({ ...S, photosSent: true }).foto.length, 0);
  assert.equal(m.toRow(S, { includePhotos: false }).foto.length, 0);
});
t('akurasi kosong pada mode crosshair tidak menjadi NaN', () => {
  const r = m.toRow({ ...S, source: 'crosshair', accuracy: null });
  assert.equal(r.akurasi_m, '');
  assert.equal(r.sumber, 'Crosshair');
});

console.log('\n== pemecahan kelompok ==');
t('kelompok dipecah menurut ukuran, bukan hanya jumlah', () => {
  const besar = { id: 'x', foto: ['x'.repeat(2_000_000)] };
  const kecil = { id: 'y' };
  const c = m.chunkQueue([kecil, besar, kecil, besar], { maxBytes: 3.5e6 });
  assert.ok(c.length >= 2, `hanya ${c.length} kelompok`);
  for (const g of c) {
    const size = g.reduce((a, r) => a + JSON.stringify(r).length, 0);
    assert.ok(size <= 3.5e6 || g.length === 1, 'kelompok melebihi batas');
  }
});
t('satu baris raksasa tetap dikirim sendirian, tidak dibuang', () => {
  const raksasa = { id: 'big', foto: ['x'.repeat(5_000_000)] };
  const c = m.chunkQueue([raksasa], { maxBytes: 3.5e6 });
  assert.equal(c.length, 1);
  assert.equal(c[0][0].id, 'big');
});
t('antrean kosong menghasilkan nol kelompok', () => {
  assert.deepEqual(m.chunkQueue([]), []);
});

console.log('\n== penanganan galat pengiriman ==');
const cfg = { url: 'https://contoh.test/exec', token: 'rahasia' };
t('jawaban HTML dikenali sebagai kesalahan konfigurasi akses', async () => {});
{
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>Sign in</body></html>' });
  await m.sendBatch(cfg, []).then(
    () => { console.log('  FAIL jawaban HTML seharusnya ditolak'); fail++; },
    (e) => {
      const ok = /Anyone|masuk Google/i.test(e.message);
      console.log((ok ? '  ok   ' : '  FAIL ') + 'pesan galat menyebut perbaikan Who has access');
      ok ? pass++ : fail++;
    });

  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
  await m.sendBatch(cfg, []).then(
    () => { console.log('  FAIL status 403 seharusnya ditolak'); fail++; },
    (e) => { console.log('  ok   status HTTP bukan 2xx dilaporkan'); pass++; });

  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ error: 'Token salah' }) });
  await m.sendBatch(cfg, []).then(
    () => { console.log('  FAIL galat dari server seharusnya diteruskan'); fail++; },
    (e) => {
      const ok = e.message === 'Token salah';
      console.log((ok ? '  ok   ' : '  FAIL ') + 'galat dari Apps Script diteruskan apa adanya');
      ok ? pass++ : fail++;
    });

  let captured = null;
  globalThis.fetch = async (url, opt) => {
    captured = opt;
    return { ok: true, text: async () => JSON.stringify({ ok: true, updated: 2 }) };
  };
  const r = await m.sendBatch(cfg, [{ id: 'a' }, { id: 'b' }]);
  t('pengiriman berhasil mengembalikan jawaban server', () => assert.equal(r.updated, 2));
  t('memakai text/plain agar tidak memicu preflight CORS', () => {
    assert.match(captured.headers['Content-Type'], /text\/plain/);
  });
  t('token ikut dalam badan, bukan di URL', () => {
    assert.ok(!cfg.url.includes('rahasia'));
    assert.equal(JSON.parse(captured.body).token, 'rahasia');
  });
}

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
