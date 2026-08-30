/**
 * core/export/kml.js
 * ---------------------------------------------------------------------------
 * Ekspor titik validasi ke KML, KMZ (dengan foto), dan GeoJSON.
 *
 * MENGAPA KMZ, BUKAN KML BIASA, KETIKA ADA FOTO
 * ---------------------------------------------
 * KML adalah berkas XML tunggal; ia tidak dapat memuat gambar. Menyisipkan
 * foto sebagai data URI di dalam balon HTML tampak menggoda, tetapi Google
 * Earth Pro membatasi ukuran balon dan sebagian versinya menolak skema data:
 * sama sekali — hasilnya balon kosong tanpa pesan galat.
 *
 * KMZ menyelesaikannya dengan benar: ia arsip ZIP berisi doc.kml ditambah
 * folder berkas pendukung. Foto dirujuk dengan jalur relatif, dan seluruh
 * perkakas yang membaca KMZ menanganinya dengan cara yang sama.
 *
 * Bila tidak ada foto sama sekali, KML biasa dikeluarkan — berkasnya lebih
 * kecil dan dapat dibuka langsung sebagai teks.
 */

import { makeZip, dataURLToBytes } from './zip.js';

/** Lolosan karakter XML. Tanpa ini, satu tanda & pada catatan merusak berkas. */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const STYLES = `
  <Style id="sesuai">
    <IconStyle>
      <color>ff54c96b</color><scale>1.1</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.85</scale></LabelStyle>
  </Style>
  <Style id="tidakSesuai">
    <IconStyle>
      <color>ff3b3bff</color><scale>1.1</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.85</scale></LabelStyle>
  </Style>`;

/**
 * Susun isi doc.kml.
 * @param {Array} samples
 * @param {Map<string,string>} photoPaths id sampel -> jalur relatif di dalam KMZ
 */
function buildKML(samples, photoPaths = new Map(), title = 'REIS') {
  const marks = samples.map((s) => {
    const photo = photoPaths.get(s.id);
    const rows = [
      ['Nama titik', s.name],
      ['Kelas peta', s.predicted],
      ['Kelas lapangan', s.actual],
      ['Hasil', s.isCorrect ? 'Sesuai' : 'Tidak sesuai'],
      ['Sumber koordinat', s.source === 'gps' ? 'GPS' : 'Crosshair'],
      ['Akurasi GPS', s.source === 'gps' && Number.isFinite(s.accuracy)
        ? `±${s.accuracy.toFixed(1)} m` : '—'],
      ['Lintang', s.lat.toFixed(7)],
      ['Bujur', s.lon.toFixed(7)],
      ['Waktu', s.timestamp],
      ['Catatan', s.note],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');

    // Balon memakai CDATA supaya HTML di dalamnya tidak perlu dilolosi dua kali.
    const html =
      `<![CDATA[<table>` +
      rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('') +
      `</table>` +
      (photo ? `<p><img src="${esc(photo)}" width="480"/></p>` : '') +
      `]]>`;

    return `    <Placemark>
      <name>${esc(s.name || s.predicted || 'Titik')}</name>
      <styleUrl>#${s.isCorrect ? 'sesuai' : 'tidakSesuai'}</styleUrl>
      <description>${html}</description>
      <ExtendedData>
${rows.map(([k, v]) =>
  `        <Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join('\n')}
      </ExtendedData>
      <Point><coordinates>${s.lon},${s.lat},0</coordinates></Point>
    </Placemark>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(title)}</name>
    <description>${esc(`Titik validasi — ${samples.length} sampel`)}</description>
${STYLES}
${marks}
  </Document>
</kml>`;
}

/**
 * Bangun KMZ bila ada foto; KML biasa bila tidak.
 * @returns {{blob:Blob, filename:string, kind:'kmz'|'kml', photos:number}}
 */
export function exportKML(samples, { basename = 'REIS_titik' } = {}) {
  const files = [];
  const photoPaths = new Map();

  for (const s of samples) {
    const list = s.photos ?? (s.photo ? [s.photo] : []);
    if (!list.length) continue;
    // Hanya foto pertama yang ditampilkan di balon; sisanya tetap diarsipkan
    // supaya tidak hilang, dan dapat dibuka dari dalam KMZ.
    list.forEach((dataURL, i) => {
      const parsed = dataURLToBytes(dataURL);
      if (!parsed) return;
      const path = `files/${s.id}_${i + 1}.${parsed.ext}`;
      files.push({ name: path, data: parsed.bytes });
      if (i === 0) photoPaths.set(s.id, path);
    });
  }

  const kml = buildKML(samples, photoPaths);

  if (files.length === 0) {
    return {
      blob: new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
      filename: `${basename}.kml`,
      kind: 'kml',
      photos: 0,
    };
  }

  return {
    blob: makeZip(
      [{ name: 'doc.kml', data: kml }, ...files],
      'application/vnd.google-earth.kmz'
    ),
    filename: `${basename}.kmz`,
    kind: 'kmz',
    photos: files.length,
  };
}

/**
 * Ekspor titik ke GeoJSON.
 *
 * Foto sengaja TIDAK disertakan. Satu foto terkompresi berukuran 150-400 kB
 * sebagai base64; seratus titik akan menghasilkan berkas GeoJSON puluhan
 * megabita yang menolak dibuka di QGIS. Untuk foto, KMZ adalah jalurnya.
 */
export function exportSamplesGeoJSON(samples) {
  const fc = {
    type: 'FeatureCollection',
    features: samples.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        nama: s.name ?? '',
        kelas_peta: s.predicted ?? '',
        kelas_lapangan: s.actual ?? '',
        sesuai: s.isCorrect ? 1 : 0,
        sumber: s.source ?? '',
        akurasi_m: Number.isFinite(s.accuracy) ? Number(s.accuracy.toFixed(2)) : null,
        akurasi_ditandai: s.accuracyFlagged ? 1 : 0,
        jumlah_foto: (s.photos ?? []).length,
        catatan: s.note ?? '',
        waktu: s.timestamp ?? '',
      },
    })),
  };
  return {
    blob: new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' }),
    filename: 'REIS_titik.geojson',
    count: fc.features.length,
  };
}
