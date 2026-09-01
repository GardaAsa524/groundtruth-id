/**
 * core/vector/kml.js
 * ---------------------------------------------------------------------------
 * Pembaca KML menjadi GeoJSON.
 *
 * MENGAPA MENULIS SENDIRI, BUKAN MEMAKAI togeojson
 * ------------------------------------------------
 * Pustaka @tmcw/togeojson menangani jauh lebih banyak daripada yang diperlukan
 * di sini: gaya, NetworkLink, gx:Track, overlay tanah. Untuk REIS, yang perlu
 * dibaca hanya Placemark dengan geometri dasar dan atributnya — persis bentuk
 * yang dihasilkan REIS sendiri, dan yang dihasilkan Google Earth ketika orang
 * menandai titik lapangan.
 *
 * Menulis sendiri juga menutup satu celah yang sering terlewat: KML menyimpan
 * koordinat sebagai "bujur,lintang,ketinggian" dipisah spasi ATAU baris baru,
 * dengan spasi berlebih yang tidak konsisten antarperkakas. Parser yang
 * memecah hanya dengan spasi akan gagal senyap pada berkas dari ArcGIS, yang
 * menaruh tiap koordinat di baris sendiri.
 */

/** Ruang nama KML. Beberapa berkas memakainya, sebagian tidak. */
const KML_NS = 'http://www.opengis.net/kml/2.2';

/** Ambil anak langsung dengan nama tag tertentu, mengabaikan ruang nama. */
function children(node, name) {
  const out = [];
  for (const c of node.children ?? []) {
    if (c.localName === name || c.nodeName === name || c.nodeName === `kml:${name}`) {
      out.push(c);
    }
  }
  return out;
}

function firstChild(node, name) {
  return children(node, name)[0] ?? null;
}

function textOf(node, name) {
  const c = firstChild(node, name);
  return c ? (c.textContent ?? '').trim() : '';
}

/** Cari seluruh keturunan dengan nama tag tertentu, lintas ruang nama. */
function findAll(root, name) {
  const byNS = root.getElementsByTagNameNS
    ? Array.from(root.getElementsByTagNameNS('*', name))
    : [];
  if (byNS.length) return byNS;
  return Array.from(root.getElementsByTagName(name));
}

/**
 * Urai blok <coordinates>.
 *
 * Pemisahnya bisa spasi, baris baru, tab, atau campuran ketiganya — dan
 * berkas dari ArcGIS lazim menaruh satu koordinat per baris. Karena itu
 * pemecahan memakai kelas spasi putih, bukan spasi tunggal.
 */
export function parseCoordinates(text) {
  if (!text) return [];
  return text.trim().split(/\s+/).map((tok) => {
    const parts = tok.split(',');
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const alt = parts.length > 2 ? parseFloat(parts[2]) : null;
    return Number.isFinite(alt) && alt !== 0 ? [lon, lat, alt] : [lon, lat];
  }).filter(Boolean);
}

/** Cincin linear KML; KML menutup cincinnya sendiri, GeoJSON juga menuntutnya. */
function ringOf(node) {
  const c = parseCoordinates(textOf(node, 'coordinates'));
  if (c.length < 3) return null;
  const a = c[0];
  const z = c[c.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) c.push([...a]);
  return c;
}

/** Geometri satu Placemark. Mengembalikan geometri GeoJSON atau null. */
function geometryOf(node) {
  const point = firstChild(node, 'Point');
  if (point) {
    const c = parseCoordinates(textOf(point, 'coordinates'));
    return c.length ? { type: 'Point', coordinates: c[0] } : null;
  }

  const line = firstChild(node, 'LineString');
  if (line) {
    const c = parseCoordinates(textOf(line, 'coordinates'));
    return c.length >= 2 ? { type: 'LineString', coordinates: c } : null;
  }

  const poly = firstChild(node, 'Polygon');
  if (poly) {
    const luar = firstChild(poly, 'outerBoundaryIs');
    const ring = luar ? firstChild(luar, 'LinearRing') : null;
    const outer = ring ? ringOf(ring) : null;
    if (!outer) return null;

    const rings = [outer];
    for (const inner of children(poly, 'innerBoundaryIs')) {
      const lr = firstChild(inner, 'LinearRing');
      const r = lr ? ringOf(lr) : null;
      if (r) rings.push(r);
    }
    return { type: 'Polygon', coordinates: rings };
  }

  const multi = firstChild(node, 'MultiGeometry');
  if (multi) {
    const geoms = [];
    for (const child of multi.children ?? []) {
      const g = geometryOf({ children: [child] });
      if (g) geoms.push(g);
    }
    if (!geoms.length) return null;
    // Bila seluruhnya sejenis, dijadikan Multi* yang sesuai; bila campuran,
    // GeometryCollection. Ini menjaga hasilnya tetap sah menurut RFC 7946.
    const jenis = new Set(geoms.map((g) => g.type));
    if (jenis.size === 1) {
      const only = [...jenis][0];
      const peta = { Point: 'MultiPoint', LineString: 'MultiLineString', Polygon: 'MultiPolygon' };
      if (peta[only]) {
        return { type: peta[only], coordinates: geoms.map((g) => g.coordinates) };
      }
    }
    return { type: 'GeometryCollection', geometries: geoms };
  }

  return null;
}

/**
 * Atribut Placemark.
 *
 * ExtendedData didahulukan karena ia terstruktur; name dan description
 * disertakan sebagai kolom biasa supaya tetap dapat difilter dan diwarnai.
 * SimpleData (skema ArcGIS/QGIS) ditangani sama dengan Data.
 */
function propertiesOf(node) {
  const props = {};
  const nama = textOf(node, 'name');
  if (nama) props.name = nama;
  const desc = textOf(node, 'description');
  if (desc) props.description = desc;

  const ext = firstChild(node, 'ExtendedData');
  if (ext) {
    for (const d of findAll(ext, 'Data')) {
      const key = d.getAttribute('name');
      if (key) props[key] = textOf(d, 'value');
    }
    for (const sd of findAll(ext, 'SimpleData')) {
      const key = sd.getAttribute('name');
      if (key) props[key] = (sd.textContent ?? '').trim();
    }
  }

  // Angka yang tersimpan sebagai teks diubah menjadi angka, supaya penyaring
  // perbandingan dan grafik dapat memakainya tanpa konversi ulang.
  for (const [k, v] of Object.entries(props)) {
    if (k === 'name' || k === 'description') continue;
    if (typeof v === 'string' && v !== '' && /^-?\d+([.,]\d+)?$/.test(v.trim())) {
      const n = parseFloat(v.replace(',', '.'));
      if (Number.isFinite(n)) props[k] = n;
    }
  }
  return props;
}

/**
 * Urai dokumen KML menjadi FeatureCollection.
 *
 * @param {string} text isi berkas KML
 * @param {{DOMParser?:Function}} deps  suntikkan DOMParser untuk lingkungan uji
 * @returns {{fc:object, skipped:number, name:string|null}}
 */
export function parseKML(text, deps = {}) {
  const DP = deps.DOMParser ?? globalThis.DOMParser;
  if (!DP) throw new Error('DOMParser tidak tersedia di lingkungan ini.');

  const doc = new DP().parseFromString(text, 'text/xml');

  // parsererror adalah cara DOMParser melaporkan XML rusak; ia tidak melempar.
  // Tanpa pemeriksaan ini, berkas rusak menghasilkan nol fitur tanpa penjelasan.
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) {
    throw new Error(`Berkas KML tidak dapat dibaca: ${(err.textContent ?? '').trim().slice(0, 120)}`);
  }

  const placemarks = findAll(doc, 'Placemark');
  if (!placemarks.length) {
    throw new Error('Tidak ada Placemark di dalam berkas KML ini.');
  }

  const features = [];
  let skipped = 0;
  for (const pm of placemarks) {
    const geometry = geometryOf(pm);
    if (!geometry) { skipped++; continue; }
    features.push({ type: 'Feature', geometry, properties: propertiesOf(pm) });
  }

  const docNode = findAll(doc, 'Document')[0];
  const name = docNode ? textOf(docNode, 'name') || null : null;

  return { fc: { type: 'FeatureCollection', features }, skipped, name };
}
