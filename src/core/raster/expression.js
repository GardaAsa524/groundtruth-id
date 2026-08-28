/**
 * core/raster/expression.js
 * ---------------------------------------------------------------------------
 * Parser ekspresi aljabar peta.
 *
 * MENGAPA TIDAK new Function() ATAU eval()
 * ----------------------------------------
 * Menggoda sekali menulis `new Function('b1','b2', 'return ' + expr)`. Jangan.
 * Ekspresi di GroundTruth.id dapat berasal dari templat indeks yang dibagikan
 * antarpengguna dan tersimpan di Google Sheets — artinya string yang tidak
 * tepercaya. `new Function` pada string semacam itu adalah eksekusi kode arbitrer
 * di dalam sesi pengguna, lengkap dengan akses ke token webhook mereka.
 *
 * Selain itu, kita tetap memerlukan AST-nya: penerjemah GLSL di glsl.js tidak
 * bisa bekerja dari string JavaScript.
 *
 * Tata bahasa (presedensi menaik):
 *   expr    := term  (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('-' | '+')? power
 *   power   := atom ('^' unary)?
 *   atom    := NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
 */

const FUNCS = {
  // nama: [jumlah argumen, padanan GLSL]
  abs: [1, 'abs'], sqrt: [1, 'sqrt'], exp: [1, 'exp'], log: [1, 'log'],
  log2: [1, 'log2'], sin: [1, 'sin'], cos: [1, 'cos'], tan: [1, 'tan'],
  atan: [1, 'atan'], floor: [1, 'floor'], ceil: [1, 'ceil'], sign: [1, 'sign'],
  min: [2, 'min'], max: [2, 'max'], pow: [2, 'pow'], atan2: [2, 'atan'],
  clamp: [3, 'clamp'],
  // where(kondisi, jikaBenar, jikaSalah) — percabangan tanpa if, ramah GPU
  where: [3, null],
};

const CONSTS = { pi: Math.PI, e: Math.E, nan: NaN };

/* ------------------------------------------------------------------ lexer */

function tokenize(src) {
  const out = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_]/.test(c);

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v)) throw new SyntaxError(`Angka tidak sah: "${text}"`);
      out.push({ t: 'num', v, pos: i });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdent(src[j])) j++;
      out.push({ t: 'ident', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // operator perbandingan dua karakter lebih dahulu
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      out.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/^(),<>'.includes(c)) {
      out.push({ t: c === '(' || c === ')' || c === ',' ? c : 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new SyntaxError(`Karakter tidak dikenali "${c}" pada posisi ${i}`);
  }
  out.push({ t: 'eof', pos: src.length });
  return out;
}

/* ----------------------------------------------------------------- parser */

/**
 * @param {string} src
 * @param {{bands:string[]}} ctx daftar nama pita yang sah, mis. ['b1','b2','b3']
 * @returns {{ast:object, usedBands:string[]}}
 */
export function parseExpression(src, ctx = {}) {
  const bands = new Set(ctx.bands ?? []);
  const toks = tokenize(src);
  let p = 0;
  const used = new Set();

  const peek = () => toks[p];
  const eat = (type, value) => {
    const tk = toks[p];
    if (tk.t !== type || (value !== undefined && tk.v !== value)) {
      throw new SyntaxError(
        `Diharapkan ${value ?? type} pada posisi ${tk.pos}, ditemukan "${tk.v ?? tk.t}"`
      );
    }
    p++;
    return tk;
  };

  function parseExpr() {
    let left = parseCompare();
    return left;
  }

  function parseCompare() {
    let left = parseAdd();
    while (peek().t === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v)) {
      const op = eat('op').v;
      const right = parseAdd();
      left = { k: 'cmp', op, a: left, b: right };
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat('op').v;
      left = { k: 'bin', op, a: left, b: parseMul() };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = eat('op').v;
      left = { k: 'bin', op, a: left, b: parseUnary() };
    }
    return left;
  }

  function parseUnary() {
    if (peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = eat('op').v;
      const operand = parseUnary();
      return op === '-' ? { k: 'neg', a: operand } : operand;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek().t === 'op' && peek().v === '^') {
      eat('op');
      return { k: 'bin', op: '^', a: base, b: parseUnary() }; // asosiatif kanan
    }
    return base;
  }

  function parseAtom() {
    const tk = peek();
    if (tk.t === 'num') { eat('num'); return { k: 'num', v: tk.v }; }

    if (tk.t === '(') {
      eat('(');
      const e = parseExpr();
      eat(')');
      return e;
    }

    if (tk.t === 'ident') {
      eat('ident');
      const name = tk.v;
      if (peek().t === '(') {
        const spec = FUNCS[name.toLowerCase()];
        if (!spec) throw new SyntaxError(`Fungsi tidak dikenal: "${name}"`);
        eat('(');
        const args = [];
        if (peek().t !== ')') {
          args.push(parseExpr());
          while (peek().t === ',') { eat(','); args.push(parseExpr()); }
        }
        eat(')');
        if (args.length !== spec[0]) {
          throw new SyntaxError(`${name}() memerlukan ${spec[0]} argumen, diberi ${args.length}`);
        }
        return { k: 'call', name: name.toLowerCase(), args };
      }
      const lower = name.toLowerCase();
      if (lower in CONSTS) return { k: 'num', v: CONSTS[lower] };
      if (bands.size && !bands.has(name)) {
        throw new SyntaxError(
          `Pita "${name}" tidak ada pada berkas ini. Tersedia: ${[...bands].join(', ')}`
        );
      }
      used.add(name);
      return { k: 'band', name };
    }

    throw new SyntaxError(`Ekspresi tidak lengkap pada posisi ${tk.pos}`);
  }

  const ast = parseExpr();
  if (peek().t !== 'eof') {
    throw new SyntaxError(`Sisa masukan tidak terpakai pada posisi ${peek().pos}`);
  }
  return { ast, usedBands: [...used] };
}

/* --------------------------------------------------- evaluator CPU (rujukan) */

/**
 * Evaluasi AST untuk satu piksel. Dipakai sebagai jalur cadangan bila WebGL
 * tidak tersedia, dan sebagai kebenaran acuan pada uji: hasil GLSL diperiksa
 * terhadap fungsi ini.
 */
export function evaluate(ast, env) {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'band': {
      const v = env[ast.name];
      if (v === undefined) throw new Error(`Pita "${ast.name}" tidak tersedia`);
      return v;
    }
    case 'neg': return -evaluate(ast.a, env);
    case 'bin': {
      const a = evaluate(ast.a, env);
      const b = evaluate(ast.b, env);
      switch (ast.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? NaN : a / b;  // pembagian nol -> NoData
        case '^': return Math.pow(a, b);
        default: throw new Error(`Operator tak terduga ${ast.op}`);
      }
    }
    case 'cmp': {
      const a = evaluate(ast.a, env);
      const b = evaluate(ast.b, env);
      switch (ast.op) {
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        default: throw new Error(`Perbandingan tak terduga ${ast.op}`);
      }
    }
    case 'call': {
      const a = ast.args.map((x) => evaluate(x, env));
      switch (ast.name) {
        case 'where': return a[0] !== 0 ? a[1] : a[2];
        case 'log2': return Math.log2(a[0]);
        case 'atan2': return Math.atan2(a[0], a[1]);
        case 'clamp': return Math.min(Math.max(a[0], a[1]), a[2]);
        case 'sign': return Math.sign(a[0]);
        default: return Math[ast.name](...a);
      }
    }
    default: throw new Error(`Simpul AST tidak dikenal: ${ast.k}`);
  }
}

/** Templat indeks spektral yang sering dipakai, untuk tombol pintas di UI. */
export const INDEX_PRESETS = [
  { id: 'ndvi', label: 'NDVI', expr: '(nir - red) / (nir + red)', range: [-1, 1],
    note: 'Kerapatan vegetasi. Sentinel-2: nir=B8, red=B4.' },
  { id: 'ndbi', label: 'NDBI', expr: '(swir1 - nir) / (swir1 + nir)', range: [-1, 1],
    note: 'Indeks terbangun. Sentinel-2: swir1=B11.' },
  { id: 'ndwi', label: 'NDWI', expr: '(green - nir) / (green + nir)', range: [-1, 1],
    note: 'Badan air (McFeeters).' },
  { id: 'mndwi', label: 'MNDWI', expr: '(green - swir1) / (green + swir1)', range: [-1, 1],
    note: 'Air, lebih tahan terhadap gangguan lahan terbangun.' },
  { id: 'savi', label: 'SAVI', expr: '1.5 * (nir - red) / (nir + red + 0.5)', range: [-1, 1.5],
    note: 'Vegetasi dengan koreksi latar tanah, L=0.5.' },
  { id: 'bsi', label: 'BSI', expr: '((swir1 + red) - (nir + blue)) / ((swir1 + red) + (nir + blue))',
    range: [-1, 1], note: 'Indeks tanah terbuka.' },
];
