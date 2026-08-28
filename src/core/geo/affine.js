/**
 * core/geo/affine.js
 * ---------------------------------------------------------------------------
 * Transformasi affine 2D dan pencocokan kuadrat terkecil.
 *
 * Seluruh rantai georeferensi GeoPDF pada akhirnya adalah rangkaian affine:
 *
 *   piksel kanvas  ->  ruang pengguna PDF  ->  koordinat terproyeksi (CRS)
 *
 * Menyimpannya sebagai matriks tunggal membuat penggambaran ubin menjadi satu
 * panggilan ctx.setTransform(), bukan perhitungan per piksel.
 *
 * Bentuk matriks (sama dengan urutan argumen CanvasRenderingContext2D):
 *   [ a c e ]     x' = a·x + c·y + e
 *   [ b d f ]     y' = b·x + d·y + f
 *   [ 0 0 1 ]
 */

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function compose(m1, m2) {
  // hasil: terapkan m2 lebih dahulu, lalu m1
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-15) throw new Error('Matriks affine singular, tidak dapat dibalik');
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** Ukuran piksel dalam satuan tujuan (skala rata-rata geometris). */
export function scaleOf(m) {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** Rotasi matriks dalam derajat, berguna untuk menampilkan info ke pengguna. */
export function rotationOf(m) {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

/**
 * Cocokkan affine dari N pasangan titik dengan kuadrat terkecil.
 *
 * Mengapa kuadrat terkecil dan bukan sekadar tiga titik?
 *   GeoPDF menyimpan GPTS hanya dengan lima desimal (~1.1 m pada lintang ini).
 *   Empat sudut yang seharusnya membentuk persegi panjang sempurna karena itu
 *   sedikit tidak konsisten. Memakai tiga sudut saja meneruskan seluruh galat
 *   pembulatan satu sudut ke seluruh lembar; kuadrat terkecil meratakannya dan
 *   memberi kita residual sebagai ukuran mutu yang bisa ditampilkan ke pengguna.
 *
 * @param {Array<{x:number,y:number}>} src minimal 3 titik
 * @param {Array<{x:number,y:number}>} dst
 * @returns {{matrix:object, residuals:number[], rmse:number}}
 */
export function fitAffine(src, dst) {
  if (src.length !== dst.length) throw new Error('Jumlah titik sumber dan tujuan berbeda');
  if (src.length < 3) throw new Error('Perlu minimal 3 pasangan titik untuk affine');

  // Normal equation: (AᵀA)·p = Aᵀb, disusun terpisah untuk x' dan y'
  // karena keduanya memakai matriks desain A yang sama.
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, S1 = 0;
  let Tx_x = 0, Tx_y = 0, Tx_1 = 0;
  let Ty_x = 0, Ty_y = 0, Ty_1 = 0;

  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    Sxx += x * x; Sxy += x * y; Sx += x;
    Syy += y * y; Sy += y; S1 += 1;
    Tx_x += X * x; Tx_y += X * y; Tx_1 += X;
    Ty_x += Y * x; Ty_y += Y * y; Ty_1 += Y;
  }

  const N = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, S1],
  ];
  const px = solve3(N, [Tx_x, Tx_y, Tx_1]);
  const py = solve3(N, [Ty_x, Ty_y, Ty_1]);

  const matrix = { a: px[0], c: px[1], e: px[2], b: py[0], d: py[1], f: py[2] };

  const residuals = src.map((s, i) => {
    const p = apply(matrix, s.x, s.y);
    return Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
  });
  const rmse = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length);
  return { matrix, residuals, rmse };
}

/** Eliminasi Gauss dengan pivot parsial untuk sistem 3x3. */
function solve3(Ain, bin) {
  const M = Ain.map((r, i) => [...r, bin[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('Sistem tak tentu: titik kontrol kolinear');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const k = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= k * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
