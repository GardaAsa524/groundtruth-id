/**
 * core/geopdf/GeoPDFGridLayer.js
 * ---------------------------------------------------------------------------
 * Lapisan Leaflet yang menempatkan kanvas GeoPDF di atas peta dasar.
 *
 * MENGAPA GridLayer, BUKAN L.ImageOverlay
 * ---------------------------------------
 * L.imageOverlay meregangkan satu gambar ke dalam kotak lintang-bujur. Itu
 * mengandaikan citra sudah sejajar sumbu lintang-bujur. GeoPDF dari ArcGIS/QGIS
 * hampir selalu "utara grid" (sejajar sumbu Y UTM), sehingga penempelan langsung
 * memutar seluruh peta sebesar konvergensi meridian — pada 107.5°E sekitar
 * 0.31°, atau ~1.7 m di sudut lembar 365 m. Untuk aplikasi uji akurasi, galat
 * sistematis sebesar itu tidak dapat diterima: ia langsung mencemari matriks
 * konfusi.
 *
 * Alternatif yang biasa dipakai orang:
 *   (a) melakukan warp seluruh citra ke kisi Web Mercator sekali di awal
 *       -> boros memori, dan resamplingnya menurunkan ketajaman;
 *   (b) plugin ImageOverlay.Rotated
 *       -> hanya menangani rotasi, bukan skala anisotropik atau shear.
 *
 * Pendekatan di sini: subkelas L.GridLayer yang menggambar ubin 256x256 langsung
 * dari kanvas sumber memakai satu ctx.setTransform() per ubin. Di dalam satu
 * ubin, transformasi Web Mercator <-> CRS peta praktis affine (simpangan
 * < 0.01 piksel pada 256 px di lintang tropis), sehingga hasilnya tepat secara
 * geometris, hemat memori, dan hanya menggambar apa yang terlihat.
 */

/**
 * @param {object} L namespace Leaflet (disuntikkan agar modul ini tetap murni)
 */
export function createGeoPDFGridLayer(L) {
  return L.GridLayer.extend({
    options: {
      opacity: 1,
      // Ubin di luar cakupan lembar dibiarkan transparan.
      keepBuffer: 2,
      className: 'gt-geopdf-layer',
    },

    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.sourceCanvas  hasil render pdf.js
     * @param {object} opts.georef                   dari buildGeoref()
     * @param {object} opts.crsToCanvas              matriks affine gabungan
     * @param {number[]} opts.userBBox               bbox viewport (ruang pengguna)
     */
    initialize(opts) {
      L.setOptions(this, opts);
      this._src = opts.sourceCanvas;
      this._georef = opts.georef;
      this._m = opts.crsToCanvas;          // CRS -> piksel kanvas sumber
      this._userBBox = opts.userBBox;
      this._clipPath = this._buildClipPath(opts);
    },

    /**
     * Poligon pemotong dalam ruang kanvas sumber, supaya bagian lembar di luar
     * BBox bergeoreferensi (margin, legenda, kop peta) tidak ikut tergambar.
     */
    _buildClipPath(opts) {
      const [x0, y0, x1, y1] = opts.userBBox;
      const u2c = opts.userToCanvas;
      const corners = [
        [x0, y0], [x0, y1], [x1, y1], [x1, y0],
      ].map(([x, y]) => ({
        x: u2c.a * x + u2c.c * y + u2c.e,
        y: u2c.b * x + u2c.d * y + u2c.f,
      }));
      return corners;
    },

    createTile(coords, done) {
      const tile = L.DomUtil.create('canvas', 'leaflet-tile');
      const size = this.getTileSize();
      const dpr = window.devicePixelRatio || 1;
      tile.width = size.x * dpr;
      tile.height = size.y * dpr;
      tile.style.width = `${size.x}px`;
      tile.style.height = `${size.y}px`;

      // Menggambar secara asinkron agar tidak memblokir gulir peta.
      requestAnimationFrame(() => {
        try {
          this._drawTile(tile, coords, dpr);
          done(null, tile);
        } catch (err) {
          done(err, tile);
        }
      });
      return tile;
    },

    _drawTile(tile, coords, dpr) {
      const ctx = tile.getContext('2d');
      const map = this._map;
      const size = this.getTileSize();

      // Sudut ubin dalam piksel layar pada zoom ubin ini
      const nwPoint = coords.scaleBy(size);
      const sePoint = nwPoint.add(size);

      // piksel ubin -> lat/lon -> CRS peta -> piksel kanvas sumber.
      // Kita hitung untuk tiga sudut saja lalu turunkan matriks affine-nya;
      // ini tepat karena kedua ruang terhubung oleh proyeksi yang mulus dan
      // ubinnya kecil.
      const p00 = this._tilePixelToSource(nwPoint, coords.z, map);
      const p10 = this._tilePixelToSource(L.point(sePoint.x, nwPoint.y), coords.z, map);
      const p01 = this._tilePixelToSource(L.point(nwPoint.x, sePoint.y), coords.z, map);
      if (!p00 || !p10 || !p01) return;

      // Matriks yang memetakan (0,0),(w,0),(0,h) ubin ke ketiga titik sumber.
      const w = size.x;
      const h = size.y;
      const a = (p10.x - p00.x) / w;
      const b = (p10.y - p00.y) / w;
      const c = (p01.x - p00.x) / h;
      const d = (p01.y - p00.y) / h;

      // Lewati ubin yang sama sekali tidak beririsan dengan area bergeoreferensi.
      if (!this._tileIntersects([p00, p10, p01])) return;

      // Kita perlu arah sebaliknya: sumber -> ubin.
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-12) return;
      const ia = d / det;
      const ib = -b / det;
      const ic = -c / det;
      const id = a / det;
      const ie = -(ia * p00.x + ic * p00.y);
      const iff = -(ib * p00.x + id * p00.y);

      ctx.save();
      ctx.scale(dpr, dpr);

      // Potong sesuai neatline agar margin lembar tidak ikut tampil.
      ctx.beginPath();
      this._clipPath.forEach((pt, i) => {
        const tx = ia * pt.x + ic * pt.y + ie;
        const ty = ib * pt.x + id * pt.y + iff;
        i === 0 ? ctx.moveTo(tx, ty) : ctx.lineTo(tx, ty);
      });
      ctx.closePath();
      ctx.clip();

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = this.options.opacity;
      ctx.setTransform(ia * dpr, ib * dpr, ic * dpr, id * dpr, ie * dpr, iff * dpr);
      ctx.drawImage(this._src, 0, 0);
      ctx.restore();
    },

    /** piksel ubin absolut -> piksel kanvas sumber */
    _tilePixelToSource(point, z, map) {
      const latlng = map.unproject(point, z);
      const p = this._georef.toCRS(latlng.lat, latlng.lng);
      const m = this._m;
      return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    },

    _tileIntersects(pts) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const pad = this.getTileSize().x * 2;
      return (
        Math.max(...xs) > -pad &&
        Math.min(...xs) < this._src.width + pad &&
        Math.max(...ys) > -pad &&
        Math.min(...ys) < this._src.height + pad
      );
    },

    setOpacityValue(v) {
      this.options.opacity = v;
      this.redraw();
    },
  });
}

/**
 * Batas lintang-bujur lembar, untuk map.fitBounds().
 * Dihitung dengan mencuplik tepi BBox, bukan hanya keempat sudut, karena tepi
 * kotak UTM melengkung ringan dalam ruang lintang-bujur.
 */
export function georefBounds(georef, bbox, samples = 16) {
  const [x0, y0, x1, y1] = bbox;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const edge = [
      [x0 + t * (x1 - x0), y0],
      [x0 + t * (x1 - x0), y1],
      [x0, y0 + t * (y1 - y0)],
      [x1, y0 + t * (y1 - y0)],
    ];
    for (const [ux, uy] of edge) {
      const { lat, lon } = georef.userToLonLat(ux, uy);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}
