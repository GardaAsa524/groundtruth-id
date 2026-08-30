/**
 * core/vector/reproject.js
 * ---------------------------------------------------------------------------
 * Deteksi dan reproyeksi sistem koordinat data vektor.
 *
 * MASALAH YANG DITANGANI
 * ----------------------
 * GeoJSON RFC 7946 mewajibkan koordinat lintang-bujur WGS 84, dan melarang
 * anggota "crs". Tetapi ArcGIS, QGIS, dan banyak perkakas lain tetap
 * mengekspor GeoJSON dengan koordinat terproyeksi apa adanya — sering kali
 * UTM, karena itulah CRS kerja di Indonesia.
 *
 * Akibatnya diam dan membingungkan: Leaflet menerima (783000, 9239000) sebagai
 * lintang-bujur, menempatkannya jauh di luar bumi, lalu `fitBounds` melompat ke
 * tempat yang tidak masuk akal. Peta tampak kosong, kueri tetap melaporkan
 * "1 / 1 fitur cocok", dan tidak ada satu pun pesan galat.
 *
 * Karena itu koordinat yang jelas-jelas terproyeksi ditolak dengan pesan yang
 * dapat ditindaklanjuti, bukan diterima diam-diam.
 */

import { epsgToDescriptor, makeTransformer } from '../geo/projection.js';

/** Ambil koordinat pertama yang ditemukan dari geometri apa pun. */
function firstCoord(geom) {
  if (!geom) return null;
  if (geom.type === 'GeometryCollection') {
    for (const g of geom.geometries ?? []) {
      const c = firstCoord(g);
      if (c) return c;
    }
    return null;
  }
  let c = geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && Number.isFinite(c[0]) ? c : null;
}

/**
 * Baca anggota `crs` gaya lama (GeoJSON 2008) bila ada.
 * Bentuk yang beredar:
 *   { type:'name', properties:{ name:'EPSG:32748' } }
 *   { type:'name', properties:{ name:'urn:ogc:def:crs:EPSG::32748' } }
 */
export function epsgFromCRSMember(fc) {
  const name = fc?.crs?.properties?.name;
  if (typeof name !== 'string') return null;
  const m = name.match(/EPSG:{1,2}(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Ambil kode EPSG dari string WKT berkas .prj shapefile. */
export function epsgFromPRJ(prjText) {
  if (typeof prjText !== 'string') return null;
  const auth = prjText.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]\s*\]?\s*$/i);
  if (auth) return Number(auth[1]);
  // WKT ArcGIS lama tidak menyertakan AUTHORITY; kenali UTM dari namanya.
  const utm = prjText.match(/UTM[_ ]?Zone[_ ]?(\d+)([NS])/i);
  if (utm) {
    const zone = Number(utm[1]);
    return utm[2].toUpperCase() === 'S' ? 32700 + zone : 32600 + zone;
  }
  return null;
}

/**
 * Periksa apakah koordinat FeatureCollection masuk akal sebagai lintang-bujur.
 *
 * Mencuplik beberapa fitur, bukan semuanya: satu koordinat sudah cukup untuk
 * membedakan 107.56 dari 783000, dan pemindaian penuh pada berkas besar
 * menahan thread utama tanpa manfaat.
 */
export function detectVectorCRS(fc, { sampleSize = 20 } = {}) {
  const declared = epsgFromCRSMember(fc);
  const feats = fc?.features ?? [];

  let checked = 0;
  let maxAbsX = 0;
  let maxAbsY = 0;
  for (const f of feats) {
    if (checked >= sampleSize) break;
    const c = firstCoord(f.geometry);
    if (!c) continue;
    checked++;
    maxAbsX = Math.max(maxAbsX, Math.abs(c[0]));
    maxAbsY = Math.max(maxAbsY, Math.abs(c[1]));
  }

  if (checked === 0) return { kind: 'empty', declared };

  const looksGeographic = maxAbsX <= 180 && maxAbsY <= 90;

  if (looksGeographic) {
    // Bila anggota crs menyebut CRS terproyeksi tetapi angkanya justru
    // lintang-bujur, percayai angkanya. Anggota crs sering tertinggal dari
    // ekspor sebelumnya dan tidak diperbarui.
    return { kind: 'geographic', declared, maxAbsX, maxAbsY };
  }

  return {
    kind: 'projected',
    declared,
    maxAbsX,
    maxAbsY,
    // Northing besar pada belahan selatan memakai false northing 10.000.000.
    likelySouth: maxAbsY > 1e6,
  };
}

/**
 * Tebak zona UTM dari nilai northing dan easting saja — tidak mungkin tepat,
 * jadi fungsi ini hanya mengembalikan daftar kandidat untuk ditawarkan ke
 * pengguna, bukan satu jawaban yang berpura-pura pasti.
 *
 * Wilayah Indonesia mencakup zona 46 sampai 54.
 */
export function utmZoneCandidates(south = true) {
  const out = [];
  for (let z = 46; z <= 54; z++) {
    out.push({
      epsg: (south ? 32700 : 32600) + z,
      label: `WGS 84 / UTM ${z}${south ? 'S' : 'N'}`,
      zone: z,
      south,
    });
  }
  return out;
}

/** Terapkan fungsi transformasi ke setiap koordinat geometri, rekursif. */
function mapCoords(coords, fn) {
  if (typeof coords[0] === 'number') {
    const { lat, lon } = fn(coords[0], coords[1]);
    // Dimensi ketiga (tinggi) dipertahankan bila ada.
    return coords.length > 2 ? [lon, lat, coords[2]] : [lon, lat];
  }
  return coords.map((c) => mapCoords(c, fn));
}

function mapGeometry(geom, fn) {
  if (!geom) return geom;
  if (geom.type === 'GeometryCollection') {
    return { ...geom, geometries: (geom.geometries ?? []).map((g) => mapGeometry(g, fn)) };
  }
  if (!geom.coordinates) return geom;
  return { ...geom, coordinates: mapCoords(geom.coordinates, fn) };
}

/**
 * Reproyeksi seluruh FeatureCollection ke WGS 84 lintang-bujur.
 *
 * @param {object} fc
 * @param {number} epsg kode EPSG sumber
 * @param {{proj4?:any}} opt
 * @returns {{fc:object, reprojected:boolean, error?:string}}
 */
export function reprojectToWGS84(fc, epsg, opt = {}) {
  const descriptor = epsgToDescriptor(Number(epsg));
  if (descriptor.kind === 'geographic') {
    return { fc, reprojected: false };
  }

  let tf;
  try {
    tf = makeTransformer(descriptor, opt.proj4 ?? null);
  } catch (e) {
    return { fc, reprojected: false, error: e.message };
  }

  const out = {
    type: 'FeatureCollection',
    features: (fc.features ?? []).map((f) => ({
      type: 'Feature',
      geometry: mapGeometry(f.geometry, (x, y) => tf.toWGS84(x, y)),
      properties: f.properties ?? {},
    })),
  };
  // Anggota crs sengaja dihilangkan: keluarannya kini benar-benar CRS84,
  // sesuai RFC 7946.
  return { fc: out, reprojected: true, sourceEPSG: Number(epsg) };
}

/** Kotak pembatas lintang-bujur dari FeatureCollection, untuk zoom ke lapisan. */
export function boundsOf(fc) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  let any = false;

  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      any = true;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      return;
    }
    for (const c of coords) visit(c);
  };

  const walk = (geom) => {
    if (!geom) return;
    if (geom.type === 'GeometryCollection') {
      (geom.geometries ?? []).forEach(walk);
      return;
    }
    if (geom.coordinates) visit(geom.coordinates);
  };

  for (const f of fc?.features ?? []) walk(f.geometry);
  if (!any) return null;

  // Satu titik tunggal menghasilkan kotak berukuran nol; Leaflet menanggapinya
  // dengan melompat ke zoom maksimum. Beri margin kecil supaya tetap wajar.
  if (minLat === maxLat && minLon === maxLon) {
    const pad = 0.0015;   // ~165 m
    return [[minLat - pad, minLon - pad], [maxLat + pad, maxLon + pad]];
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}
