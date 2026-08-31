/**
 * core/accuracy/heat.js
 * ---------------------------------------------------------------------------
 * Peta panas kerapatan titik validasi.
 *
 * APA YANG SEBENARNYA INGIN DILIHAT
 * ---------------------------------
 * Peta panas kerapatan sampel hanya menjawab "di mana saya mengambil sampel".
 * Itu berguna untuk memeriksa sebaran, tetapi bukan temuan.
 *
 * Yang menjadi temuan adalah peta panas KESALAHAN: di mana klasifikasi gagal.
 * Bila titik-titik tidak sesuai mengelompok di satu sudut area, itu bukan
 * derau acak melainkan pola — biasanya menunjuk ke satu kelas tutupan lahan
 * yang tercampur, bayangan awan, atau perbedaan tanggal perekaman citra.
 * Karena itu modul ini menyediakan tiga tampilan, dan yang kedua adalah
 * alasan sebenarnya fitur ini ada.
 */

export const HEAT_MODES = {
  ALL: 'all',            // kerapatan seluruh sampel
  ERRORS: 'errors',      // hanya yang tidak sesuai
  ACCURACY: 'accuracy',  // proporsi kesalahan setempat
};

/**
 * Pilih titik yang akan dipanaskan beserta bobotnya.
 *
 * Mode ACCURACY memberi bobot berdasarkan proporsi kesalahan di sekitar tiap
 * titik, bukan sekadar jumlah. Kerapatan mentah menyesatkan pada sampel
 * berstrata: area yang disampel lebih rapat akan tampak "lebih bermasalah"
 * semata-mata karena titiknya lebih banyak, padahal tingkat kesalahannya
 * mungkin justru lebih rendah.
 *
 * @returns {Array<{lat:number, lon:number, weight:number}>}
 */
export function heatPoints(samples, mode = HEAT_MODES.ERRORS, opt = {}) {
  const { radiusMeters = 60 } = opt;
  const pts = (samples ?? []).filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));

  if (mode === HEAT_MODES.ALL) {
    return pts.map((s) => ({ lat: s.lat, lon: s.lon, weight: 1 }));
  }

  if (mode === HEAT_MODES.ERRORS) {
    return pts.filter((s) => s.isCorrect === false)
      .map((s) => ({ lat: s.lat, lon: s.lon, weight: 1 }));
  }

  // ACCURACY: bobot = proporsi kesalahan tetangga dalam radius tertentu.
  // Titik yang benar tetapi dikelilingi kesalahan tetap ikut menyala, karena
  // yang dipetakan adalah keadaan wilayah, bukan nasib satu titik.
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const out = [];

  for (const s of pts) {
    let n = 0;
    let salah = 0;
    for (const o of pts) {
      // Jarak bidang datar sudah memadai di sini: radiusnya puluhan meter,
      // dan hasilnya hanya menentukan bobot visual, bukan angka yang dilaporkan.
      const dy = rad(o.lat - s.lat) * R;
      const dx = rad(o.lon - s.lon) * R * Math.cos(rad(s.lat));
      if (dx * dx + dy * dy <= radiusMeters * radiusMeters) {
        n++;
        if (o.isCorrect === false) salah++;
      }
    }
    if (n === 0) continue;
    const rasio = salah / n;
    if (rasio > 0) out.push({ lat: s.lat, lon: s.lon, weight: rasio });
  }
  return out;
}

/** Gradien peta panas. Kuning ke merah: konvensi baku untuk "lebih banyak". */
export const HEAT_GRADIENT = [
  [0.0, [0, 0, 0, 0]],
  [0.25, [64, 148, 196, 140]],
  [0.45, [120, 200, 130, 180]],
  [0.65, [245, 200, 60, 210]],
  [0.85, [240, 130, 40, 230]],
  [1.0, [214, 40, 60, 240]],
];

/** Bangun tabel cari warna 256 entri dari gradien. */
export function buildGradientLUT(stops = HEAT_GRADIENT, size = 256) {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    for (let c = 0; c < 4; c++) {
      lut[i * 4 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
    }
  }
  return lut;
}

/**
 * Lapisan peta panas berbasis kanvas.
 *
 * Algoritmanya baku: gambar gradien radial per titik dengan komposit 'lighter'
 * ke kanvas kelabu, lalu warnai tiap piksel menurut nilai alpha yang tertumpuk.
 * Menumpuk alpha, bukan menggambar lingkaran berwarna langsung, adalah yang
 * membuat titik-titik berdekatan menyatu menjadi gumpalan yang lebih pekat
 * alih-alih sekadar saling menimpa.
 *
 * @param {object} L namespace Leaflet
 */
export function createHeatLayer(L) {
  return L.Layer.extend({
    options: {
      radius: 26,        // piksel pada zoom saat ini
      blur: 18,
      maxOpacity: 0.75,
      minPoints: 1,
    },

    initialize(points, options) {
      L.setOptions(this, options);
      this._points = points ?? [];
      this._lut = buildGradientLUT();
    },

    setPoints(points) {
      this._points = points ?? [];
      this._redraw();
      return this;
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'gt-heat-canvas');
      // Ditempatkan di overlayPane agar berada di atas peta dasar tetapi di
      // bawah penanda, sehingga titik sampel tetap dapat diketuk.
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend zoomend resize', this._redraw, this);
      this._redraw();
    },

    onRemove(map) {
      map.off('moveend zoomend resize', this._redraw, this);
      this._canvas?.remove();
      this._canvas = null;
    },

    _redraw() {
      const map = this._map;
      const canvas = this._canvas;
      if (!map || !canvas) return;

      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;

      // Kanvas mengikuti sudut kiri-atas tampilan, bukan koordinat peta.
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (this._points.length < this.options.minPoints) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      const r = this.options.radius;
      const blur = this.options.blur;

      // Tahap 1: tumpuk alpha.
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this._points) {
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (pt.x < -r || pt.y < -r || pt.x > size.x + r || pt.y > size.y + r) continue;

        const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r + blur);
        const w = Math.max(0, Math.min(1, p.weight ?? 1));
        g.addColorStop(0, `rgba(0,0,0,${0.85 * w})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + blur, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Tahap 2: warnai menurut alpha yang tertumpuk.
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      const lut = this._lut;
      const maxA = this.options.maxOpacity * 255;

      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a === 0) continue;
        const k = a * 4;
        d[i] = lut[k];
        d[i + 1] = lut[k + 1];
        d[i + 2] = lut[k + 2];
        d[i + 3] = Math.min(lut[k + 3], maxA);
      }
      ctx.putImageData(img, 0, 0);
    },
  });
}
