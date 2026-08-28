/**
 * core/raster/glsl.js
 * ---------------------------------------------------------------------------
 * Penerjemah AST -> fragment shader GLSL ES 3.0.
 *
 * Satu shader dibuat ulang setiap kali ekspresi berubah, lalu dipakai kembali
 * untuk seluruh piksel. Untuk citra Sentinel-2 satu tile (10980x10980) ini
 * berarti ~120 juta evaluasi ekspresi yang seluruhnya berjalan paralel di GPU;
 * jalur CPU setara memerlukan puluhan detik dan membekukan antarmuka.
 */

const GLSL_BIN = { '+': '+', '-': '-', '*': '*', '/': '/' };

/**
 * @param {object} ast
 * @param {string[]} bands nama pita, urutannya menentukan nama sampler
 * @returns {string} potongan ekspresi GLSL
 */
export function emitGLSL(ast, bands) {
  const idx = new Map(bands.map((b, i) => [b, i]));

  function walk(n) {
    switch (n.k) {
      case 'num':
        if (Number.isNaN(n.v)) return 'NODATA';
        return formatFloat(n.v);
      case 'band': {
        const i = idx.get(n.name);
        if (i === undefined) throw new Error(`Pita "${n.name}" tidak terikat ke sampler`);
        return `v_band${i}`;
      }
      case 'neg':
        return `(-${walk(n.a)})`;
      case 'bin': {
        const a = walk(n.a);
        const b = walk(n.b);
        if (n.op === '^') return `pow(${a}, ${b})`;
        if (n.op === '/') return `safeDiv(${a}, ${b})`;
        return `(${a} ${GLSL_BIN[n.op]} ${b})`;
      }
      case 'cmp': {
        const a = walk(n.a);
        const b = walk(n.b);
        const glslOp = n.op === '==' ? '==' : n.op === '!=' ? '!=' : n.op;
        return `((${a} ${glslOp} ${b}) ? 1.0 : 0.0)`;
      }
      case 'call': {
        const a = n.args.map(walk);
        switch (n.name) {
          case 'where': return `((${a[0]} != 0.0) ? (${a[1]}) : (${a[2]}))`;
          case 'atan2': return `atan(${a[0]}, ${a[1]})`;
          default: return `${n.name}(${a.join(', ')})`;
        }
      }
      default:
        throw new Error(`Simpul AST tidak dapat diterjemahkan: ${n.k}`);
    }
  }
  return walk(ast);
}

function formatFloat(v) {
  // GLSL menolak literal float tanpa titik desimal pada konteks tertentu
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}

export const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x, 1.0 - a_pos.y);   // balik Y: raster beroigin kiri-atas
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Rakit fragment shader lengkap.
 *
 * Penanganan NoData memakai jalur terpisah: piksel NoData tidak boleh ikut
 * dalam peregangan kontras dan harus tembus pandang, bukan hitam. Menggambar
 * NoData sebagai nol adalah kesalahan yang sering membuat NDVI tampak punya
 * "danau" gelap di tepi citra.
 */
export function buildFragmentShader(exprGLSL, bandCount, { hasNoData, colormapSize }) {
  const samplers = Array.from({ length: bandCount }, (_, i) => `uniform sampler2D u_band${i};`).join('\n');
  const fetches = Array.from(
    { length: bandCount },
    (_, i) => `  float v_band${i} = texture(u_band${i}, v_uv).r;`
  ).join('\n');
  const nodataTests = hasNoData
    ? Array.from(
        { length: bandCount },
        (_, i) => `  if (abs(v_band${i} - u_nodata) < u_nodataEps) { outColor = vec4(0.0); return; }`
      ).join('\n')
    : '';

  return `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 outColor;

${samplers}
uniform sampler2D u_ramp;        // gradien warna 1D, lebar ${colormapSize}
uniform float u_min;
uniform float u_max;
uniform float u_nodata;
uniform float u_nodataEps;
uniform float u_opacity;

const float NODATA = ${'0.0 / 0.0'};

float safeDiv(float a, float b) {
  return abs(b) < 1e-12 ? NODATA : a / b;
}

void main() {
${fetches}
${nodataTests}

  float value = ${exprGLSL};

  if (isnan(value) || isinf(value)) { outColor = vec4(0.0); return; }

  float t = clamp((value - u_min) / max(u_max - u_min, 1e-12), 0.0, 1.0);
  vec3 rgb = texture(u_ramp, vec2(t, 0.5)).rgb;
  outColor = vec4(rgb * u_opacity, u_opacity);   // alpha dikalikan di muka
}`;
}

/* --------------------------------------------------------------- colormaps */

/** Gradien warna sebagai daftar titik henti; dirender ke tekstur 1D. */
export const COLORMAPS = {
  // Divergen, netral terhadap buta warna merah-hijau; cocok untuk NDVI/NDWI.
  rdylgn: ['#a50026', '#f46d43', '#fee08b', '#d9ef8b', '#66bd63', '#006837'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
  grayscale: ['#000000', '#ffffff'],
  // Untuk hasil biner where(): dua warna tegas.
  binary: ['#1f2933', '#ff2e88'],
};

export function rampToPixels(stops, width = 256) {
  const rgb = stops.map(hexToRgb);
  const out = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = (i / (width - 1)) * (rgb.length - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, rgb.length - 1);
    const f = t - i0;
    out[i * 4 + 0] = Math.round(rgb[i0][0] + (rgb[i1][0] - rgb[i0][0]) * f);
    out[i * 4 + 1] = Math.round(rgb[i0][1] + (rgb[i1][1] - rgb[i0][1]) * f);
    out[i * 4 + 2] = Math.round(rgb[i0][2] + (rgb[i1][2] - rgb[i0][2]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function hexToRgb(h) {
  const s = h.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}
