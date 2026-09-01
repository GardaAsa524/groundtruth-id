/**
 * core/vector/area.js
 * ---------------------------------------------------------------------------
 * Perhitungan luas fitur dan agregasinya menurut kelas atribut.
 *
 * MENGAPA TIDAK SEKADAR MENJUMLAHKAN LUAS CINCIN LUAR
 * ---------------------------------------------------
 * Poligon tutupan lahan hampir selalu berlubang: petak sawah dengan bangunan
 * di tengahnya, kawasan hutan dengan danau, blok permukiman dengan lapangan.
 * Mengabaikan cincin dalam membuat luasnya terlalu besar, dan besarnya galat
 * tidak dapat ditebak — bergantung sepenuhnya pada bentuk datanya.
 *
 * Luas dihitung dengan rumus bertanda, sehingga cincin dalam yang arah
 * putarannya berlawanan otomatis mengurangi. Ini juga membuatnya tahan
 * terhadap berkas yang arah putarannya tidak mengikuti RFC 7946.
 */

import { polygonAreaSigned } from '../geo/measure.js';

const toPts = (ring) => ring.map(([lon, lat]) => ({ lat, lon }));

/**
 * Luas satu cincin poligon beserta lubangnya.
 * @param {Array} rings [cincinLuar, lubang1, lubang2, ...]
 */
function polygonWithHoles(rings) {
  if (!rings?.length) return 0;
  const luar = Math.abs(polygonAreaSigned(toPts(rings[0])));
  let lubang = 0;
  for (let i = 1; i < rings.length; i++) {
    lubang += Math.abs(polygonAreaSigned(toPts(rings[i])));
  }
  // Nilai mutlak per cincin lalu dikurangkan: lebih tahan daripada
  // mengandalkan arah putaran, yang sering keliru pada berkas nyata.
  return Math.max(0, luar - lubang);
}

/**
 * Luas satu fitur dalam meter persegi.
 * Fitur non-poligon berluas nol — garis dan titik memang tidak punya luas,
 * dan mengembalikan nol lebih jujur daripada melempar galat.
 */
export function featureArea(feature) {
  const g = feature?.geometry;
  if (!g) return 0;

  switch (g.type) {
    case 'Polygon':
      return polygonWithHoles(g.coordinates);
    case 'MultiPolygon':
      return (g.coordinates ?? []).reduce((a, poly) => a + polygonWithHoles(poly), 0);
    case 'GeometryCollection':
      return (g.geometries ?? []).reduce(
        (a, geom) => a + featureArea({ geometry: geom }), 0);
    default:
      return 0;
  }
}

/**
 * Agregasi luas menurut nilai satu kolom.
 *
 * @param {object} fc FeatureCollection
 * @param {string} field nama kolom; kosong berarti seluruhnya satu kelompok
 * @param {Uint8Array} [mask] hanya fitur bermask 1 yang dihitung
 * @returns {{rows:Array, total:number, hasArea:boolean}}
 */
export function areaByClass(fc, field, mask = null) {
  const feats = fc?.features ?? [];
  const acc = new Map();
  let total = 0;
  let berpoligon = 0;

  for (let i = 0; i < feats.length; i++) {
    if (mask && mask[i] !== 1) continue;
    const f = feats[i];
    const a = featureArea(f);
    if (a > 0) berpoligon++;

    const raw = field ? f.properties?.[field] : '';
    const key = raw === null || raw === undefined || raw === ''
      ? '' : String(raw);

    const e = acc.get(key) ?? { value: key, area: 0, count: 0 };
    e.area += a;
    e.count += 1;
    acc.set(key, e);
    total += a;
  }

  const rows = [...acc.values()]
    .map((e) => ({ ...e, share: total > 0 ? e.area / total : 0 }))
    .sort((a, b) => b.area - a.area || a.value.localeCompare(b.value));

  return { rows, total, hasArea: berpoligon > 0 };
}
