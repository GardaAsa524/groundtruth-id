/**
 * core/raster/renderer.js
 * ---------------------------------------------------------------------------
 * Mesin render kalkulator raster: WebGL2 sebagai jalur utama, Canvas 2D sebagai
 * cadangan.
 *
 * ANGGARAN MEMORI — bagian yang paling menentukan apakah modul ini bisa dipakai
 * -----------------------------------------------------------------------------
 * Satu pita Float32 berukuran 5000x5000 memakan 100 MB. Citra Sentinel-2 empat
 * pita pada resolusi penuh berarti 400 MB hanya untuk array masukan, sebelum
 * tekstur GPU dan kanvas keluaran. Peramban ponsel akan gugur jauh sebelum itu.
 *
 * Karena itu pipeline ini TIDAK PERNAH membaca resolusi penuh secara membuta:
 *   1. geotiff.js `readRasters({ width, height })` memakai piramida internal /
 *      desimasi, sehingga pembacaan sudah tereduksi di sisi pustaka.
 *   2. Ukuran kerja dibatasi `maxWorkingPixels` (bawaan 4 MP) — cukup untuk
 *      tampilan layar dan uji akurasi visual.
 *   3. Untuk ekspor pada resolusi penuh, pemrosesan dipecah menjadi jalur ubin
 *      (lihat renderTiled) sehingga puncak memori tetap datar.
 */

import {
  emitGLSL, VERTEX_SHADER, buildFragmentShader, buildRGBFragmentShader,
  rampToPixels, COLORMAPS,
} from './glsl.js';

/* ------------------------------------------------------------- statistik */

/**
 * Persentil dari cuplikan, untuk peregangan kontras.
 *
 * Memakai min/max sejati hampir selalu keliru: satu piksel awan atau piksel
 * rusak menarik seluruh rentang sehingga gambar tampak rata. Standar praktik
 * pengindraan jauh adalah potong 2%-98%. Kita menghitungnya dari cuplikan
 * tersistematis (bukan seluruh piksel) karena galat baku persentil pada
 * n=100.000 sudah jauh di bawah ketelitian visual.
 */
export function sampleStats(values, { lowPct = 2, highPct = 98, maxSamples = 100000, nodata = null } = {}) {
  const n = values.length;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const buf = [];
  for (let i = 0; i < n; i += step) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (nodata !== null && Math.abs(v - nodata) < 1e-9) continue;
    buf.push(v);
  }
  if (!buf.length) return { min: 0, max: 1, count: 0 };
  buf.sort((a, b) => a - b);
  const q = (p) => buf[Math.min(buf.length - 1, Math.max(0, Math.floor((p / 100) * (buf.length - 1))))];
  return {
    min: q(lowPct),
    max: q(highPct),
    trueMin: buf[0],
    trueMax: buf[buf.length - 1],
    median: q(50),
    count: buf.length,
  };
}

/* ------------------------------------------------------------ jalur WebGL */

export class RasterGLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,   // diperlukan agar toBlob() untuk ekspor bekerja
      antialias: false,
    });
    if (!this.gl) throw new Error('WebGL2 tidak tersedia');

    // EXT_color_buffer_float tidak diperlukan karena kita menulis ke RGBA8,
    // tetapi tekstur R32F masukan memerlukan OES_texture_float_linear hanya
    // bila kita memakai penyaringan linear. Kita memakai NEAREST, jadi aman.
    this.textures = new Map();
    this.program = null;
    this._initQuad();
  }

  _initQuad() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this._vao = vao;
    this._quadBuf = buf;
  }

  /**
   * Unggah satu pita sebagai tekstur R32F.
   * @param {string} name
   * @param {Float32Array} data
   */
  uploadBand(name, data, width, height) {
    const gl = this.gl;
    let tex = this.textures.get(name);
    if (!tex) {
      tex = gl.createTexture();
      this.textures.set(name, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f32 = data instanceof Float32Array ? data : Float32Array.from(data);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, f32);
    this.width = width;
    this.height = height;
  }

  /** Bebaskan tekstur pita yang tidak lagi dipakai ekspresi aktif. */
  releaseUnused(keep) {
    const keepSet = new Set(keep);
    for (const [name, tex] of this.textures) {
      if (!keepSet.has(name)) {
        this.gl.deleteTexture(tex);
        this.textures.delete(name);
      }
    }
  }

  compile(ast, bands, { hasNoData = false } = {}) {
    const gl = this.gl;
    const exprSrc = emitGLSL(ast, bands);
    const fragSrc = buildFragmentShader(exprSrc, bands.length, { hasNoData, colormapSize: 256 });

    const vs = this._shader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Gagal menautkan shader: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.bands = bands;
    this.mode = 'index';
    return { fragSrc, exprSrc };
  }

  /**
   * Kompilasi jalur komposit RGB.
   * @param {{r:string,g:string,b:string,alpha?:string}} roles nama pita per saluran
   */
  compileRGB(roles, { hasNoData = false } = {}) {
    const gl = this.gl;
    const hasAlpha = !!roles.alpha;
    const fragSrc = buildRGBFragmentShader({ hasNoData, hasAlpha });

    const vs = this._shader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Gagal menautkan shader RGB: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.mode = 'rgb';
    this.roles = roles;
    return { fragSrc };
  }

  renderRGB({ min, max, opacity = 1, nodata = null, gamma = 1, alphaCutoff = 0 }) {
    const gl = this.gl;
    if (!this.program || this.mode !== 'rgb') throw new Error('Shader RGB belum dikompilasi');

    this.canvas.width = this.width;
    this.canvas.height = this.height;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const bind = (name, uniform, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(name));
      gl.uniform1i(gl.getUniformLocation(this.program, uniform), unit);
    };
    bind(this.roles.r, 'u_r', 0);
    bind(this.roles.g, 'u_g', 1);
    bind(this.roles.b, 'u_b', 2);
    if (this.roles.alpha) bind(this.roles.alpha, 'u_alpha', 3);

    const u = (n) => gl.getUniformLocation(this.program, n);
    gl.uniform3f(u('u_min'), min[0], min[1], min[2]);
    gl.uniform3f(u('u_max'), max[0], max[1], max[2]);
    gl.uniform1f(u('u_opacity'), opacity);
    gl.uniform1f(u('u_nodata'), nodata ?? 0);
    gl.uniform1f(u('u_gamma'), gamma);
    gl.uniform1f(u('u_alphaCutoff'), alphaCutoff);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Kompilasi shader gagal: ${log}`);
    }
    return sh;
  }

  render({ min, max, colormap = 'viridis', opacity = 1, nodata = null }) {
    const gl = this.gl;
    if (!this.program) throw new Error('Shader belum dikompilasi');

    this.canvas.width = this.width;
    this.canvas.height = this.height;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.bands.forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(name));
      gl.uniform1i(gl.getUniformLocation(this.program, `u_band${i}`), i);
    });

    const rampUnit = this.bands.length;
    gl.activeTexture(gl.TEXTURE0 + rampUnit);
    gl.bindTexture(gl.TEXTURE_2D, this._rampTexture(colormap));
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_ramp'), rampUnit);

    const u = (n) => gl.getUniformLocation(this.program, n);
    gl.uniform1f(u('u_min'), min);
    gl.uniform1f(u('u_max'), max);
    gl.uniform1f(u('u_opacity'), opacity);
    gl.uniform1f(u('u_nodata'), nodata ?? 0);
    gl.uniform1f(u('u_nodataEps'), 1e-6);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // alpha sudah dikalikan di shader
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _rampTexture(name) {
    if (!this._ramps) this._ramps = new Map();
    if (this._ramps.has(name)) return this._ramps.get(name);
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const px = rampToPixels(COLORMAPS[name] ?? COLORMAPS.viridis, 256);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this._ramps.set(name, tex);
    return tex;
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.textures.clear();
    if (this._ramps) for (const t of this._ramps.values()) gl.deleteTexture(t);
    if (this.program) gl.deleteProgram(this.program);
    gl.deleteBuffer(this._quadBuf);
    gl.deleteVertexArray(this._vao);
    // Melepas konteks secara eksplisit; peramban membatasi ~16 konteks WebGL
    // per tab dan tidak membebaskannya hanya karena kanvasnya dilepas dari DOM.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/* ------------------------------------------------ jalur cadangan Canvas 2D */

/**
 * Evaluasi di CPU dan tulis langsung ke ImageData.
 * Dipakai bila WebGL2 tidak ada (peramban lama, GPU di-blacklist) atau untuk
 * memverifikasi hasil GPU pada uji regresi.
 */
export function renderCPU({ evaluateFn, ast, bandData, bands, width, height, min, max, colormap = 'viridis', opacity = 1, nodata = null }) {
  const ramp = rampToPixels(COLORMAPS[colormap] ?? COLORMAPS.viridis, 256);
  const out = new ImageDataPolyfill(width, height);
  const env = {};
  const span = Math.max(max - min, 1e-12);
  const alpha = Math.round(opacity * 255);

  for (let i = 0, n = width * height; i < n; i++) {
    let bad = false;
    for (const b of bands) {
      const v = bandData[b][i];
      if (nodata !== null && Math.abs(v - nodata) < 1e-9) { bad = true; break; }
      env[b] = v;
    }
    if (bad) { out.data[i * 4 + 3] = 0; continue; }

    const value = evaluateFn(ast, env);
    if (!Number.isFinite(value)) { out.data[i * 4 + 3] = 0; continue; }

    const t = Math.min(1, Math.max(0, (value - min) / span));
    const k = Math.round(t * 255) * 4;
    out.data[i * 4 + 0] = ramp[k];
    out.data[i * 4 + 1] = ramp[k + 1];
    out.data[i * 4 + 2] = ramp[k + 2];
    out.data[i * 4 + 3] = alpha;
  }
  return out;
}

/** ImageData tidak ada di lingkungan Node; ini bentuk minimal untuk pengujian. */
class ImageDataPolyfill {
  constructor(width, height) {
    if (typeof ImageData !== 'undefined') return new ImageData(width, height);
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

/**
 * Tentukan ukuran kerja yang aman untuk sebuah GeoTIFF.
 * Dipanggil sebelum readRasters() sehingga desimasi terjadi di dalam pustaka,
 * bukan setelah seluruh berkas mendarat di memori.
 */
export function planWorkingSize(fullWidth, fullHeight, {
  maxWorkingPixels = 4e6,
  bandCount = 1,
  bytesPerSample = 4,
  memoryBudgetBytes = 256e6,
} = {}) {
  const byPixels = maxWorkingPixels;
  const byMemory = memoryBudgetBytes / (bandCount * bytesPerSample);
  const target = Math.min(byPixels, byMemory);
  const full = fullWidth * fullHeight;
  if (full <= target) return { width: fullWidth, height: fullHeight, decimation: 1 };
  const f = Math.sqrt(target / full);
  return {
    width: Math.max(1, Math.round(fullWidth * f)),
    height: Math.max(1, Math.round(fullHeight * f)),
    decimation: 1 / f,
  };
}
