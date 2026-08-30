/**
 * core/accuracy/confusionMatrix.js
 * ---------------------------------------------------------------------------
 * Metrik uji akurasi untuk pasangan (kelas peta prediksi, kelas observasi lapangan).
 *
 * Modul ini mengambil masukan langsung dari sakelar validasi Truth/False dan
 * dari kolom kelas pada titik observasi.
 *
 * CATATAN METODOLOGIS YANG PENTING UNTUK PUBLIKASI
 * ------------------------------------------------
 * Overall Accuracy yang dihitung mentah dari hitungan sampel hanya sahih bila
 * sampel diambil secara acak sederhana. Pada praktiknya hampir semua uji akurasi
 * memakai stratified random sampling per kelas peta — dan pada rancangan itu,
 * OA mentah bias karena kelas langka menjadi terwakili berlebih.
 *
 * Karena itu modul ini menyediakan dua jalur:
 *   - metrik berbasis hitungan (untuk pemeriksaan cepat di lapangan);
 *   - metrik terboboti luas mengikuti Olofsson et al. (2014), yang merupakan
 *     praktik baku yang diminta reviewer jurnal pengindraan jauh.
 *
 * Kappa disediakan karena masih diminta banyak instansi, tetapi perlu dicatat
 * bahwa literatur mutakhir (Pontius & Millones 2011; Foody 2020) menyarankan
 * agar Kappa tidak dijadikan metrik utama karena ia menghukum akurasi tinggi
 * pada kelas tidak seimbang dan sulit ditafsirkan. Sertakan, jangan andalkan.
 */

/**
 * @typedef {Object} Sample
 * @property {string} predicted kelas pada peta
 * @property {string} actual    kelas hasil observasi lapangan
 * @property {number} [weight]  bobot opsional
 */

/**
 * Bangun matriks konfusi.
 * Konvensi: baris = kelas peta (predicted), kolom = kelas rujukan (actual).
 * Ini konvensi Congalton/Olofsson; membaliknya menukar arti User's dan
 * Producer's Accuracy, kesalahan yang sangat sering terjadi.
 */
export function buildMatrix(samples, classesInput = null) {
  const classes = classesInput ?? [
    ...new Set(samples.flatMap((s) => [s.predicted, s.actual].filter((v) => v != null && v !== ''))),
  ].sort();

  const idx = new Map(classes.map((c, i) => [c, i]));
  const k = classes.length;
  const m = Array.from({ length: k }, () => new Float64Array(k));
  let skipped = 0;

  for (const s of samples) {
    const r = idx.get(s.predicted);
    const c = idx.get(s.actual);
    if (r === undefined || c === undefined) { skipped++; continue; }
    m[r][c] += s.weight ?? 1;
  }
  return { classes, matrix: m, skipped, n: samples.length - skipped };
}

/**
 * Metrik berbasis hitungan.
 * @returns per-kelas UA/PA/F1 dan agregat OA, macro/micro F1, Kappa.
 */
export function computeMetrics({ classes, matrix }) {
  const k = classes.length;
  const rowSum = new Float64Array(k);
  const colSum = new Float64Array(k);
  let total = 0;
  let diag = 0;

  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      rowSum[i] += matrix[i][j];
      colSum[j] += matrix[i][j];
      total += matrix[i][j];
      if (i === j) diag += matrix[i][j];
    }
  }
  if (total === 0) return null;

  const perClass = classes.map((name, i) => {
    const tp = matrix[i][i];
    // User's Accuracy = presisi: dari yang dipetakan sebagai kelas ini, berapa benar.
    const ua = rowSum[i] > 0 ? tp / rowSum[i] : NaN;
    // Producer's Accuracy = recall: dari yang sebenarnya kelas ini, berapa terpetakan.
    const pa = colSum[i] > 0 ? tp / colSum[i] : NaN;
    const f1 = Number.isFinite(ua) && Number.isFinite(pa) && ua + pa > 0
      ? (2 * ua * pa) / (ua + pa) : NaN;
    return {
      name,
      mapped: rowSum[i],
      reference: colSum[i],
      correct: tp,
      usersAccuracy: ua,
      producersAccuracy: pa,
      commissionError: Number.isFinite(ua) ? 1 - ua : NaN,
      omissionError: Number.isFinite(pa) ? 1 - pa : NaN,
      f1,
    };
  });

  const oa = diag / total;

  // Kappa Cohen
  let pe = 0;
  for (let i = 0; i < k; i++) pe += (rowSum[i] / total) * (colSum[i] / total);
  const kappa = pe < 1 ? (oa - pe) / (1 - pe) : NaN;

  // Ragam Kappa (Congalton & Green) untuk selang kepercayaan
  let th3 = 0;
  let th4 = 0;
  for (let i = 0; i < k; i++) {
    th3 += (matrix[i][i] / total) * ((rowSum[i] + colSum[i]) / total);
    for (let j = 0; j < k; j++) {
      th4 += (matrix[i][j] / total) * Math.pow((colSum[i] + rowSum[j]) / total, 2);
    }
  }
  const t1 = oa;
  const t2 = pe;
  const varKappa =
    (1 / total) *
    ((t1 * (1 - t1)) / Math.pow(1 - t2, 2) +
      (2 * (1 - t1) * (2 * t1 * t2 - th3)) / Math.pow(1 - t2, 3) +
      (Math.pow(1 - t1, 2) * (th4 - 4 * t2 * t2)) / Math.pow(1 - t2, 4));

  const valid = perClass.filter((c) => Number.isFinite(c.f1));
  const macroF1 = valid.length ? valid.reduce((a, c) => a + c.f1, 0) / valid.length : NaN;
  // Micro-F1 pada klasifikasi multikelas satu-label identik dengan OA.
  const microF1 = oa;

  // Selang kepercayaan 95% OA, pendekatan Wald
  const seOA = Math.sqrt((oa * (1 - oa)) / total);

  return {
    classes,
    total,
    overallAccuracy: oa,
    overallAccuracyCI95: [Math.max(0, oa - 1.96 * seOA), Math.min(1, oa + 1.96 * seOA)],
    kappa,
    kappaSE: Number.isFinite(varKappa) && varKappa > 0 ? Math.sqrt(varKappa) : NaN,
    macroF1,
    microF1,
    perClass,
    rowSum: Array.from(rowSum),
    colSum: Array.from(colSum),
  };
}

/**
 * Akurasi terboboti luas — Olofsson et al. (2014), "Good practices for
 * estimating area and assessing accuracy of land change".
 *
 * @param {{classes:string[], matrix:Float64Array[]}} cm
 * @param {Record<string,number>} mapAreas luas tiap kelas pada peta
 *        (satuan bebas asal konsisten: piksel, hektar, km²)
 *
 * Yang dikoreksi: sel matriks diubah dari hitungan sampel menjadi proporsi luas
 * p_ij = W_i * n_ij / n_i, dengan W_i = proporsi luas kelas peta i. Setelah itu
 * OA, UA, PA dihitung dari p, bukan dari n.
 */
export function computeAreaAdjusted({ classes, matrix }, mapAreas) {
  const k = classes.length;
  const areas = classes.map((c) => mapAreas?.[c] ?? 0);
  const totalArea = areas.reduce((a, b) => a + b, 0);
  if (totalArea <= 0) return null;

  const W = areas.map((a) => a / totalArea);
  const nRow = classes.map((_, i) => matrix[i].reduce((a, b) => a + b, 0));

  // p_ij
  const p = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (nRow[i] > 0 ? (W[i] * matrix[i][j]) / nRow[i] : 0))
  );

  const pColSum = Array.from({ length: k }, (_, j) => p.reduce((a, row) => a + row[j], 0));
  const oa = p.reduce((a, row, i) => a + row[i], 0);

  const perClass = classes.map((name, i) => {
    const ua = W[i] > 0 ? p[i][i] / W[i] : NaN;
    const pa = pColSum[i] > 0 ? p[i][i] / pColSum[i] : NaN;
    // Luas terkoreksi kelas i beserta galat bakunya (Olofsson pers. 9-10)
    const areaProportion = pColSum[i];
    let seArea = 0;
    for (let ii = 0; ii < k; ii++) {
      if (nRow[ii] <= 1) continue;
      const nij = matrix[ii][i];
      const ni = nRow[ii];
      seArea += (W[ii] * W[ii] * (nij / ni) * (1 - nij / ni)) / (ni - 1);
    }
    seArea = Math.sqrt(seArea);
    return {
      name,
      usersAccuracy: ua,
      producersAccuracy: pa,
      f1: Number.isFinite(ua) && Number.isFinite(pa) && ua + pa > 0 ? (2 * ua * pa) / (ua + pa) : NaN,
      mapArea: areas[i],
      adjustedArea: areaProportion * totalArea,
      adjustedAreaCI95: 1.96 * seArea * totalArea,
      sampleCount: nRow[i],
    };
  });

  // Galat baku OA terboboti
  let varOA = 0;
  for (let i = 0; i < k; i++) {
    const ni = nRow[i];
    if (ni <= 1) continue;
    const ui = matrix[i][i] / ni;
    varOA += (W[i] * W[i] * ui * (1 - ui)) / (ni - 1);
  }
  const seOA = Math.sqrt(varOA);

  return {
    overallAccuracy: oa,
    overallAccuracyCI95: [Math.max(0, oa - 1.96 * seOA), Math.min(1, oa + 1.96 * seOA)],
    perClass,
    proportionMatrix: p,
    note:
      'Metrik terboboti luas mengikuti Olofsson et al. (2014). Gunakan angka ini ' +
      'untuk pelaporan bila sampel diambil secara stratified per kelas peta.',
  };
}

/**
 * Jalur khusus sakelar biner Truth/False.
 * Di lapangan, banyak validasi hanya menanyakan "apakah kelas peta di titik ini
 * benar?" tanpa mencatat kelas sebenarnya. Data seperti itu hanya bisa
 * menghasilkan User's Accuracy per kelas peta — tidak bisa menghasilkan
 * Producer's Accuracy atau Kappa, karena kolom rujukan tidak pernah terisi.
 * Fungsi ini menghitung apa yang sah, dan menyatakan secara eksplisit apa
 * yang tidak, supaya pengguna tidak melaporkan angka yang tidak dapat
 * dipertahankan.
 */
export function computeBinaryValidation(samples) {
  const byClass = new Map();
  let correct = 0;
  let n = 0;
  for (const s of samples) {
    if (s.isCorrect === null || s.isCorrect === undefined) continue;
    const c = s.predicted ?? '(tanpa kelas)';
    let e = byClass.get(c);
    if (!e) { e = { name: c, n: 0, correct: 0 }; byClass.set(c, e); }
    e.n++;
    n++;
    if (s.isCorrect) { e.correct++; correct++; }
  }
  const perClass = [...byClass.values()].map((e) => {
    const ua = e.n ? e.correct / e.n : NaN;
    const se = e.n ? Math.sqrt((ua * (1 - ua)) / e.n) : NaN;
    return {
      ...e,
      usersAccuracy: ua,
      ci95: [Math.max(0, ua - 1.96 * se), Math.min(1, ua + 1.96 * se)],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    n,
    overallCorrectRate: n ? correct / n : NaN,
    perClass,
    limitation:
      "Validasi biner hanya menghasilkan User's Accuracy. Producer's Accuracy, " +
      'Kappa, dan F1 memerlukan kelas rujukan yang tercatat, bukan sekadar benar/salah.',
  };
}

/** Ekspor matriks ke CSV untuk lampiran laporan. */
export function matrixToCSV({ classes, matrix }, metrics) {
  const sep = ';';
  const rows = [];
  rows.push(['Peta \\ Rujukan', ...classes, 'Total', "User's Acc"].join(sep));
  classes.forEach((c, i) => {
    const total = matrix[i].reduce((a, b) => a + b, 0);
    const ua = metrics?.perClass?.[i]?.usersAccuracy;
    rows.push([
      c,
      ...Array.from(matrix[i], (v) => String(v)),
      String(total),
      Number.isFinite(ua) ? ua.toFixed(4) : '',
    ].join(sep));
  });
  const colTotals = classes.map((_, j) => matrix.reduce((a, r) => a + r[j], 0));
  rows.push(['Total', ...colTotals.map(String), String(metrics?.total ?? ''), ''].join(sep));
  rows.push([
    "Producer's Acc",
    ...classes.map((_, j) => {
      const pa = metrics?.perClass?.[j]?.producersAccuracy;
      return Number.isFinite(pa) ? pa.toFixed(4) : '';
    }),
    '', '',
  ].join(sep));
  rows.push('');
  rows.push(['Overall Accuracy', metrics?.overallAccuracy?.toFixed(4) ?? ''].join(sep));
  rows.push(['Kappa', metrics?.kappa?.toFixed(4) ?? ''].join(sep));
  rows.push(['Macro F1', metrics?.macroF1?.toFixed(4) ?? ''].join(sep));
  return '\uFEFF' + rows.join('\r\n');
}
