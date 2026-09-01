/**
 * components/AttributeQueryBuilder.jsx
 * ---------------------------------------------------------------------------
 * Penyusun kueri atribut + lapisan vektor yang menghormati hasilnya.
 *
 * KEPUTUSAN KINERJA UTAMA
 * -----------------------
 * Lapisan GeoJSON dibuat SEKALI. Perubahan filter tidak membangunnya ulang;
 * hanya `setStyle` yang dipanggil pada tiap layer anak. Untuk 20.000 poligon,
 * membangun ulang berarti membuang dan mencipta 20.000 simpul SVG (ratusan
 * milidetik, disertai lonjakan pengumpulan sampah). Mengubah gaya menyentuh
 * atribut yang sudah ada dan selesai dalam ~15 ms.
 *
 * Untuk cacah fitur besar, renderer kanvas dipakai: SVG mulai tersendat di
 * sekitar 5.000 jalur, sedangkan kanvas menangani puluhan ribu.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  inferSchema, compileQuery, applyQuery, queryToSQL, summarizeField,
  emptyGroup, newRule, OPERATORS, FIELD_TYPES,
} from '../core/vector/query.js';
import {
  detectVectorCRS, reprojectToWGS84, boundsOf, epsgFromPRJ, utmZoneCandidates,
} from '../core/vector/reproject.js';
import { parseKML } from '../core/vector/kml.js';
import {
  uniqueValues, buildColorMap, styleFor, legendEntries, PALETTE,
} from '../core/vector/style.js';
import { useLocale } from '../context/AppProviders.jsx';

/* --------------------------------------------------------------- pemuatan */

export function useVectorFile() {
  const [state, setState] = useState({
    status: 'idle', fc: null, schema: null, error: null,
    crs: null, needsCRS: false, bounds: null, name: null,
  });
  const rawRef = useRef(null);      // data mentah sebelum reproyeksi

  /** Terapkan CRS ke data mentah dan siapkan hasilnya. */
  const applyCRS = useCallback((epsg) => {
    const raw = rawRef.current;
    if (!raw) return;
    const { fc, reprojected, error } = reprojectToWGS84(raw, epsg);
    if (error) { setState((s) => ({ ...s, error })); return; }
    setState((s) => ({
      ...s,
      status: 'ready',
      fc,
      schema: inferSchema(fc),
      bounds: boundsOf(fc),
      needsCRS: false,
      error: null,
      crs: { epsg: Number(epsg), reprojected },
    }));
  }, []);

  const load = useCallback(async (files) => {
    setState({ status: 'loading', fc: null, schema: null, error: null,
      crs: null, needsCRS: false, bounds: null, name: null });
    try {
      const list = Array.from(files);

      // Hanya GeoJSON. Dukungan Shapefile dilepas dengan sengaja: formatnya
      // terdiri dari beberapa berkas yang harus dipilih bersamaan, dan pemilih
      // berkas ganda pada peramban ponsel tidak dapat diandalkan. Pengguna
      // sering hanya membawa .shp tanpa .dbf, sehingga tabel atributnya hilang
      // dan seluruh modul kueri menjadi tidak berguna. GeoJSON satu berkas dan
      // selalu membawa atributnya.
      const berkas = list[0];
      if (!berkas) throw new Error('Tidak ada berkas dipilih.');
      const name = berkas.name;
      const teks = await berkas.text();
      let fc;

      if (/\.kml$/i.test(name)) {
        // KML selalu lintang-bujur WGS 84 menurut spesifikasinya, jadi tidak
        // ada langkah deteksi CRS untuk jalur ini.
        const hasil = parseKML(teks);
        fc = hasil.fc;
        if (hasil.skipped > 0) {
          console.warn(`${hasil.skipped} Placemark tanpa geometri dilewati.`);
        }
      } else if (/\.(geojson|json)$/i.test(name)) {
        fc = JSON.parse(teks);
      } else {
        throw new Error(
          'Format tidak didukung. Gunakan GeoJSON atau KML. Bila data Anda ' +
          'berupa Shapefile, ekspor dahulu ke GeoJSON dari QGIS atau ArcGIS ' +
          '(klik kanan lapisan → Export → Save Features As → GeoJSON).'
        );
      }
      const prjEPSG = null;

      rawRef.current = fc;
      const detected = detectVectorCRS(fc);

      if (detected.kind === 'geographic') {
        setState({
          status: 'ready', fc, schema: inferSchema(fc), bounds: boundsOf(fc),
          error: null, crs: { epsg: 4326, reprojected: false }, needsCRS: false, name,
        });
        return;
      }

      // Terproyeksi. Cari kode EPSG dari sumber yang tersedia.
      const epsg = detected.declared ?? prjEPSG;
      if (epsg) {
        const { fc: out, reprojected, error } = reprojectToWGS84(fc, epsg);
        if (error) throw new Error(error);
        setState({
          status: 'ready', fc: out, schema: inferSchema(out), bounds: boundsOf(out),
          error: null, crs: { epsg: Number(epsg), reprojected }, needsCRS: false, name,
        });
        return;
      }

      // Tidak ada informasi CRS sama sekali. Menebak zonanya dari nilai easting
      // dan northing saja mustahil, jadi kita bertanya alih-alih menempatkan
      // data di lokasi yang salah tanpa memberi tahu.
      setState({
        status: 'needs-crs', fc: null, schema: null, bounds: null, error: null,
        needsCRS: true, name,
        crs: { likelySouth: detected.likelySouth, sample: [detected.maxAbsX, detected.maxAbsY] },
      });
    } catch (err) {
      setState({ status: 'error', fc: null, schema: null, error: err.message,
        crs: null, needsCRS: false, bounds: null, name: null });
    }
  }, []);

  const clear = useCallback(() => {
    rawRef.current = null;
    setState({ status: 'idle', fc: null, schema: null, error: null,
      crs: null, needsCRS: false, bounds: null, name: null });
  }, []);

  return { ...state, load, applyCRS, clear };
}

/** Penanya CRS, muncul hanya bila berkas terproyeksi tanpa keterangan EPSG. */
export function CRSPrompt({ vector, onPick }) {
  const { t } = useLocale();
  const [epsg, setEpsg] = useState('');
  if (!vector.needsCRS) return null;

  const opsi = utmZoneCandidates(vector.crs?.likelySouth ?? true);

  return (
    <div className="gt-crs-prompt">
      <p className="gt-gps-alert">{t('vector.projectedNoCRS')}</p>
      <p className="gt-hint mono">
        contoh koordinat: {Math.round(vector.crs?.sample?.[0] ?? 0)},{' '}
        {Math.round(vector.crs?.sample?.[1] ?? 0)}
      </p>
      <label className="gt-field">
        {t('vector.pickCRS')}
        <select value={epsg} onChange={(e) => setEpsg(e.target.value)}>
          <option value="">—</option>
          {opsi.map((o) => (
            <option key={o.epsg} value={o.epsg}>{o.label} (EPSG:{o.epsg})</option>
          ))}
        </select>
      </label>
      <button type="button" className="gt-btn-primary" disabled={!epsg}
        onClick={() => onPick(epsg)}>
        {t('vector.applyCRS')}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- UI kueri */

function RuleRow({ rule, schema, onChange, onRemove, t }) {
  const field = schema.find((f) => f.name === rule.field);
  const type = field?.type ?? FIELD_TYPES.STRING;
  const ops = OPERATORS[type] ?? OPERATORS[FIELD_TYPES.STRING];
  const needsValue = !['isNull', 'notNull'].includes(rule.operator);

  return (
    <div className="gt-rule">
      <select
        value={rule.field}
        onChange={(e) => {
          const f = schema.find((x) => x.name === e.target.value);
          // Operator direset saat tipe berubah: ">" pada kolom teks tidak masuk akal.
          onChange({ ...rule, field: e.target.value, operator: OPERATORS[f?.type ?? FIELD_TYPES.STRING][0], value: '' });
        }}
      >
        <option value="">{t('query.selectField')}</option>
        {schema.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name} ({f.type})
          </option>
        ))}
      </select>

      <select value={rule.operator} onChange={(e) => onChange({ ...rule, operator: e.target.value })}>
        {ops.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>

      {needsValue && (
        field?.categories ? (
          <select value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">—</option>
            {field.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input
            type={type === FIELD_TYPES.NUMBER ? 'number' : 'text'}
            value={rule.value ?? ''}
            placeholder={field?.range ? `${field.range[0]} … ${field.range[1]}` : ''}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          />
        )
      )}

      {rule.operator === 'between' && (
        <input
          type="number"
          value={rule.value2 ?? ''}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })}
        />
      )}

      <button type="button" className="gt-icon-btn" onClick={onRemove} aria-label={t('query.removeRule')}>×</button>
    </div>
  );
}

function GroupEditor({ node, schema, onChange, onRemove, depth, t }) {
  const update = (i, child) => {
    const rules = [...node.rules];
    rules[i] = child;
    onChange({ ...node, rules });
  };
  const removeAt = (i) => onChange({ ...node, rules: node.rules.filter((_, k) => k !== i) });

  return (
    <div className={`gt-group depth-${Math.min(depth, 3)}`}>
      <div className="gt-group-head">
        <div className="gt-seg">
          {['AND', 'OR'].map((op) => (
            <button key={op} type="button"
              className={node.op === op ? 'is-on' : ''}
              onClick={() => onChange({ ...node, op })}>{op}</button>
          ))}
        </div>
        <label className="gt-check">
          <input type="checkbox" checked={!!node.not}
            onChange={(e) => onChange({ ...node, not: e.target.checked })} />
          NOT
        </label>
        <span className="gt-spacer" />
        <button type="button" onClick={() => onChange({ ...node, rules: [...node.rules, newRule(schema[0])] })}>
          + {t('query.addRule')}
        </button>
        {depth < 3 && (
          <button type="button" onClick={() => onChange({ ...node, rules: [...node.rules, emptyGroup('OR')] })}>
            + {t('query.addGroup')}
          </button>
        )}
        {onRemove && <button type="button" className="gt-icon-btn" onClick={onRemove}>×</button>}
      </div>

      {node.rules.length === 0 && <p className="gt-hint">{t('query.emptyGroup')}</p>}

      {node.rules.map((child, i) =>
        child.kind === 'group' ? (
          <GroupEditor key={i} node={child} schema={schema} depth={depth + 1} t={t}
            onChange={(c) => update(i, c)} onRemove={() => removeAt(i)} />
        ) : (
          <RuleRow key={i} rule={child} schema={schema} t={t}
            onChange={(c) => update(i, c)} onRemove={() => removeAt(i)} />
        )
      )}
    </div>
  );
}

export function AttributeQueryBuilder({ fc, schema, onResult }) {
  const { t, nf } = useLocale();
  const [tree, setTree] = useState(() => emptyGroup('AND'));
  const [summaryField, setSummaryField] = useState('');

  // Kompilasi + penerapan di-memo. Ini satu-satunya tempat seluruh
  // FeatureCollection disentuh, dan hanya berjalan saat pohon berubah.
  const result = useMemo(() => {
    if (!fc || !schema) return null;
    const t0 = performance.now();
    const pred = compileQuery(tree, schema);
    const r = applyQuery(fc, pred);
    return { ...r, sql: queryToSQL(tree), ms: performance.now() - t0 };
  }, [fc, schema, tree]);

  useEffect(() => { if (result) onResult?.(result); }, [result]); // eslint-disable-line

  const summary = useMemo(() => {
    if (!result || !summaryField) return null;
    const f = schema.find((x) => x.name === summaryField);
    return summarizeField(fc, result.mask, summaryField, f?.type);
  }, [result, summaryField, fc, schema]);

  if (!fc || !schema) return <p className="gt-hint">{t('query.noData')}</p>;

  const aktif = (tree.rules ?? []).length > 0;

  return (
    <div className="gt-query-builder">
      {/*
        Kueri bersifat opsional, seperti Definition Query di ArcGIS: memuat
        lapisan sudah cukup untuk melihat dan memvalidasinya. Panel penyaring
        karena itu tertutup secara bawaan dan hanya dibuka bila diperlukan.
      */}
      <details className="gt-details" open={aktif}>
        <summary>
          {t('query.filterOptional')}
          {aktif && <span className="gt-badge-on">{t('query.filterActive')}</span>}
        </summary>
        <GroupEditor node={tree} schema={schema} depth={0} t={t} onChange={setTree} />
        {aktif && (
          <button type="button" className="gt-linkish"
            onClick={() => setTree(emptyGroup('AND'))}>
            {t('query.clearFilter')}
          </button>
        )}
      </details>

      <div className="gt-query-result">
        {aktif && <code className="gt-sql">{result?.sql}</code>}
        <p>
          <strong>{nf(result?.matched ?? 0, 0)}</strong> / {nf(result?.total ?? 0, 0)}{' '}
          {t('query.featuresMatched')}
          <span className="gt-hint mono"> · {nf(result?.ms ?? 0, 1)} ms</span>
        </p>
      </div>

      <label className="gt-field">
        {t('query.summarize')}
        <select value={summaryField} onChange={(e) => setSummaryField(e.target.value)}>
          <option value="">—</option>
          {schema.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
      </label>

      {summary && (
        <div className="gt-summary">
          {summary.categories ? (
            <ul>
              {summary.categories.map(([k, v]) => (
                <li key={k}><span>{k}</span><span className="mono">{v}</span></li>
              ))}
            </ul>
          ) : (
            <dl className="gt-quality">
              <div><dt>n</dt><dd className="mono">{summary.count}</dd></div>
              <div><dt>min</dt><dd className="mono">{nf(summary.min)}</dd></div>
              <div><dt>max</dt><dd className="mono">{nf(summary.max)}</dd></div>
              <div><dt>mean</dt><dd className="mono">{nf(summary.mean)}</dd></div>
              <div><dt>median</dt><dd className="mono">{nf(summary.median)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- simbologi kelas */

/**
 * Pengaturan pewarnaan berdasarkan nilai atribut.
 * Padanan "Unique Values" di ArcGIS: pilih kolom, tiap nilai dapat warnanya.
 */
export function SymbologyPanel({ fc, schema, value, onChange }) {
  const { t, nf } = useLocale();
  const { field, colors } = value ?? { field: '', colors: {} };

  const entries = useMemo(
    () => (field ? legendEntries(fc, field, colors) : []),
    [fc, field, colors]
  );

  const pickField = (f) => {
    if (!f) { onChange({ field: '', colors: {} }); return; }
    // Warna dibangun sekali saat kolom dipilih, lalu disimpan. Menghitungnya
    // ulang tiap render membuat warna berkedip saat pengguna mengubah filter.
    onChange({ field: f, colors: buildColorMap(uniqueValues(fc, f)) });
  };

  // Kolom kategorikal saja: mewarnai kolom angka kontinu menghasilkan ratusan
  // kategori dan legenda yang tidak terbaca.
  const kandidat = (schema ?? []).filter(
    (f) => f.categories || f.type === 'boolean' || (f.type === 'string')
  );

  return (
    <div className="gt-symbology">
      <label className="gt-field">
        {t('symbology.field')}
        <select value={field} onChange={(e) => pickField(e.target.value)}>
          <option value="">{t('symbology.single')}</option>
          {kandidat.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}{f.categories ? ` (${f.categories.length})` : ''}
            </option>
          ))}
        </select>
      </label>

      {entries.length > 0 && (
        <>
          <div className="gt-legend">
            {entries.map((e) => (
              <div key={e.value} className="gt-legend-row">
                <input type="color" value={e.color}
                  aria-label={`${t('symbology.color')} ${e.label}`}
                  onChange={(ev) => onChange({
                    field, colors: { ...colors, [e.value]: ev.target.value },
                  })} />
                <span className="gt-legend-label" title={e.label}>{e.label}</span>
                <span className="mono gt-legend-count">{nf(e.count, 0)}</span>
              </div>
            ))}
          </div>
          <button type="button" className="gt-linkish"
            onClick={() => onChange({ field, colors: buildColorMap(uniqueValues(fc, field)) })}>
            {t('symbology.reset')}
          </button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------- lapisan terfilter */

export function FilteredVectorLayer({ fc, mask, mode = 'dim', symbology, onFeatureClick }) {
  const map = useMap();
  const layerRef = useRef(null);
  const indexRef = useRef(new Map());   // index fitur -> layer Leaflet

  // Bangun sekali per dataset.
  useEffect(() => {
    if (!fc || !map) return undefined;
    indexRef.current.clear();
    let i = 0;

    const layer = L.geoJSON(fc, {
      // Kanvas untuk cacah fitur besar; SVG di bawah ambang itu tetap lebih
      // tajam dan mendukung hover dengan lebih baik.
      renderer: fc.features.length > 4000 ? L.canvas({ padding: 0.5 }) : L.svg({ padding: 0.5 }),
      style: (feat) => styleFor(feat.properties, symbology),
      pointToLayer: (feat, latlng) => L.circleMarker(latlng, { radius: 5 }),
      onEachFeature: (feature, lyr) => {
        indexRef.current.set(i, lyr);
        lyr.__idx = i;
        i += 1;
        lyr.on('click', () => onFeatureClick?.(feature, lyr.__idx));
      },
    });
    layer.addTo(map);
    layerRef.current = layer;
    try { map.fitBounds(layer.getBounds(), { padding: [16, 16] }); } catch { /* geometri kosong */ }

    return () => { map.removeLayer(layer); layerRef.current = null; indexRef.current.clear(); };
  }, [fc, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // Terapkan mask dan simbologi tanpa membangun ulang apa pun.
  useEffect(() => {
    const idx = indexRef.current;
    if (!idx.size || !fc) return;
    const feats = fc.features;

    idx.forEach((lyr, i) => {
      const on = !mask || mask[i] === 1;
      const props = feats[i]?.properties;

      if (!on && mode === 'hide') {
        // Disembunyikan lewat gaya, bukan removeLayer: menambah dan menghapus
        // ribuan layer memaksa Leaflet menghitung ulang indeks spasialnya.
        lyr.setStyle?.({ opacity: 0, fillOpacity: 0 });
        if (lyr._path) lyr._path.style.pointerEvents = 'none';
        return;
      }
      if (lyr._path) lyr._path.style.pointerEvents = '';
      lyr.setStyle?.(styleFor(props, { ...symbology, dimmed: !on }));
    });
  }, [mask, mode, symbology, fc]);

  return null;
}
