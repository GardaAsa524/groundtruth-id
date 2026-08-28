/**
 * core/geopdf/parseGeoPDF.js
 * ---------------------------------------------------------------------------
 * Ekstraksi parameter georeferensi dari berkas PDF.
 *
 * KEPUTUSAN ARSITEKTUR YANG PALING PENTING DI MODUL INI
 * -----------------------------------------------------
 * PDF.js **tidak** memaparkan kamus /VP (Viewport) melalui API publiknya.
 * `PDFPageProxy.getViewport()` sama sekali tidak berhubungan — itu viewport
 * tampilan, bukan viewport geospasial. Mengambilnya lewat properti internal
 * (`page._pageDict`) berubah antarversi dan akan patah tanpa peringatan.
 *
 * Karena itu kita membelah tugas:
 *   pdf-lib  -> membaca struktur objek PDF (termasuk object stream terkompresi
 *               dan xref stream) untuk mendapatkan kamus georeferensi.
 *   pdf.js   -> khusus rasterisasi halaman menjadi piksel.
 *
 * Keduanya membaca ArrayBuffer yang sama, jadi tidak ada unduhan ganda.
 *
 * DUA ENCODING YANG BEREDAR DI LAPANGAN
 * -------------------------------------
 * 1. OGC / ISO 32000-2 ("geospatial PDF") — dihasilkan ArcGIS Pro, QGIS.
 *    Halaman punya /VP [ << /Type/Viewport /BBox [...] /Measure << /Subtype/GEO
 *    /GPTS [...] /LPTS [...] /GCS << /WKT (...) >> >> >> ]
 * 2. TerraGo GeoPDF — kamus LGIDict di /PieceInfo << /TerraGo << /Private ...
 *    Memakai /CTM atau /Neatline + /Projection. Masih banyak di berkas lama
 *    instansi. Kita baca sebagai jalur cadangan.
 *
 * Keluaran modul ini sengaja dinormalkan sehingga sisa aplikasi tidak perlu
 * tahu encoding asalnya.
 */

import { describeCRS } from '../geo/projection.js';

/**
 * @typedef {Object} GeoPDFViewport
 * @property {number[]} bbox        [x0,y0,x1,y1] dalam ruang pengguna PDF (pt)
 * @property {Array<{lat:number,lon:number}>} gpts  sudut geografis
 * @property {Array<{u:number,v:number}>} lpts      sudut ternormalisasi (0..1) di dalam bbox
 * @property {object} crs           deskriptor dari describeCRS()
 * @property {string} encoding      'ogc' | 'terrago'
 * @property {string} [name]
 */

/* ---------------------------------------------------------------- util pdf-lib */

const num = (v) => (typeof v?.asNumber === 'function' ? v.asNumber() : Number(v?.numberValue ?? v));

/** Baca array angka dari objek pdf-lib, menembus referensi tak langsung. */
function numArray(ctx, obj) {
  const arr = deref(ctx, obj);
  if (!arr || typeof arr.asArray !== 'function') return null;
  return arr.asArray().map((el) => num(deref(ctx, el)));
}

function deref(ctx, obj) {
  // PDFRef -> objek sebenarnya
  return obj && obj.constructor?.name === 'PDFRef' ? ctx.lookup(obj) : obj;
}

function dictGet(ctx, dict, key) {
  if (!dict || typeof dict.get !== 'function') return undefined;
  return deref(ctx, dict.get(pdfName(dict, key)));
}

/** pdf-lib memerlukan objek PDFName; kita ambil dari konstruktor yang sama. */
let PDFNameCtor = null;
function pdfName(sample, key) {
  if (!PDFNameCtor) {
    // ambil kelas PDFName dari salah satu kunci yang sudah ada di kamus
    const anyKey = sample.keys?.()[0];
    PDFNameCtor = anyKey?.constructor ?? null;
  }
  return PDFNameCtor?.of ? PDFNameCtor.of(key) : key;
}

/* ---------------------------------------------------------------- OGC */

/**
 * Ambil seluruh viewport bergeoreferensi dari satu halaman.
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {number} pageIndex
 * @returns {GeoPDFViewport[]}
 */
export function readOGCViewports(pdfDoc, pageIndex = 0) {
  const ctx = pdfDoc.context;
  const page = pdfDoc.getPage(pageIndex);
  const node = page.node;

  const vp = dictGet(ctx, node, 'VP');
  if (!vp || typeof vp.asArray !== 'function') return [];

  const out = [];
  for (const entryRef of vp.asArray()) {
    const entry = deref(ctx, entryRef);
    const measure = dictGet(ctx, entry, 'Measure');
    if (!measure) continue;

    const subtype = dictGet(ctx, measure, 'Subtype');
    const st = subtype?.encodedName ?? subtype?.asString?.() ?? String(subtype ?? '');
    if (!/GEO/i.test(st)) continue;

    const bbox = numArray(ctx, entry.get(pdfName(entry, 'BBox')));
    const gptsFlat = numArray(ctx, measure.get(pdfName(measure, 'GPTS')));
    let lptsFlat = numArray(ctx, measure.get(pdfName(measure, 'LPTS')));
    if (!bbox || !gptsFlat) continue;

    // LPTS bersifat opsional; bila hilang, standar mengasumsikan empat sudut
    // BBox berurutan berlawanan arah jarum jam dari kiri-bawah.
    if (!lptsFlat || lptsFlat.length < gptsFlat.length) {
      lptsFlat = [0, 0, 0, 1, 1, 1, 1, 0];
    }

    // GPTS disimpan sebagai pasangan (lintang, bujur) — bukan (bujur, lintang).
    // Ini sumber bug klasik; ISO 32000-2 §8.8.2 memang mendahulukan lintang.
    const gpts = [];
    for (let i = 0; i + 1 < gptsFlat.length; i += 2) {
      gpts.push({ lat: gptsFlat[i], lon: gptsFlat[i + 1] });
    }
    const lpts = [];
    for (let i = 0; i + 1 < lptsFlat.length; i += 2) {
      lpts.push({ u: lptsFlat[i], v: lptsFlat[i + 1] });
    }

    const gcsDict = dictGet(ctx, measure, 'GCS');
    let wkt = null;
    let epsg = null;
    if (gcsDict) {
      const wktObj = dictGet(ctx, gcsDict, 'WKT');
      wkt = wktObj?.asString?.() ?? wktObj?.decodeText?.() ?? null;
      if (typeof wkt === 'string') wkt = wkt.replace(/^\(|\)$/g, '');
      const epsgObj = dictGet(ctx, gcsDict, 'EPSG');
      if (epsgObj != null) epsg = num(epsgObj);
    }

    const nameObj = dictGet(ctx, entry, 'Name');

    out.push({
      bbox,
      gpts,
      lpts,
      crs: describeCRS(epsg ? { epsg } : wkt),
      encoding: 'ogc',
      name: nameObj?.asString?.()?.replace(/^\(|\)$/g, '') ?? undefined,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- TerraGo */

/**
 * Jalur cadangan untuk TerraGo GeoPDF.
 * Kamus LGIDict menyimpan /CTM (enam angka: transformasi ruang pengguna ->
 * koordinat terproyeksi) dan /Neatline. Kita ubah menjadi bentuk yang sama
 * dengan hasil OGC agar sisa pipeline tidak perlu bercabang.
 */
export function readTerraGoViewports(pdfDoc, pageIndex = 0) {
  const ctx = pdfDoc.context;
  const page = pdfDoc.getPage(pageIndex);
  const pieceInfo = dictGet(ctx, page.node, 'PieceInfo');
  if (!pieceInfo) return [];
  const terrago = dictGet(ctx, pieceInfo, 'TerraGo');
  const priv = terrago ? dictGet(ctx, terrago, 'Private') : null;
  if (!priv) return [];

  const lgi = dictGet(ctx, priv, 'LGIDict');
  const dicts = lgi?.asArray ? lgi.asArray().map((d) => deref(ctx, d)) : lgi ? [lgi] : [];

  const out = [];
  for (const d of dicts) {
    const ctm = numArray(ctx, d.get(pdfName(d, 'CTM')));
    const neat = numArray(ctx, d.get(pdfName(d, 'Neatline')));
    if (!ctm || ctm.length < 6) continue;

    const proj = dictGet(ctx, d, 'Projection');
    const projType = proj ? dictGet(ctx, proj, 'ProjectionType') : null;
    const zoneObj = proj ? dictGet(ctx, proj, 'Zone') : null;
    const hemi = proj ? dictGet(ctx, proj, 'Hemisphere') : null;

    let crs = { kind: 'geographic' };
    const pt = projType?.asString?.() ?? '';
    if (/UT/i.test(pt) && zoneObj != null) {
      crs = {
        kind: 'utm',
        zone: num(zoneObj),
        south: /S/i.test(hemi?.asString?.() ?? ''),
      };
    }

    // Neatline adalah poligon dalam ruang pengguna; ambil kotak pembatasnya.
    let bbox = [0, 0, 612, 792];
    if (neat && neat.length >= 8) {
      const xs = neat.filter((_, i) => i % 2 === 0);
      const ys = neat.filter((_, i) => i % 2 === 1);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    out.push({
      bbox,
      ctm: { a: ctm[0], b: ctm[1], c: ctm[2], d: ctm[3], e: ctm[4], f: ctm[5] },
      gpts: null,
      lpts: null,
      crs,
      encoding: 'terrago',
    });
  }
  return out;
}

/**
 * Titik masuk tunggal. Mencoba OGC dahulu, lalu TerraGo.
 * @param {ArrayBuffer} buffer isi berkas PDF
 * @param {{PDFDocument:any}} deps  suntikkan { PDFDocument } dari 'pdf-lib'
 */
export async function parseGeoPDF(buffer, deps, pageIndex = 0) {
  const { PDFDocument } = deps;
  const pdfDoc = await PDFDocument.load(buffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  let viewports = readOGCViewports(pdfDoc, pageIndex);
  if (viewports.length === 0) viewports = readTerraGoViewports(pdfDoc, pageIndex);

  const page = pdfDoc.getPage(pageIndex);
  const { width, height } = page.getSize();

  return {
    pageCount: pdfDoc.getPageCount(),
    pageIndex,
    pageSize: { width, height },   // dalam titik PDF (1/72 inci)
    viewports,
    georeferenced: viewports.length > 0,
  };
}
