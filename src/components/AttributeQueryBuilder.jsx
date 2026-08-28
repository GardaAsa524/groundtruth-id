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
import { useLocale } from '../context/AppProviders.jsx';

/* --------------------------------------------------------------- pemuatan */

export function useVectorFile() {
  const [state, setState] = useState({ status: 'idle', fc: null, schema: null, error: null });

  const load = useCallback(async (files) => {
    setState({ status: 'loading', fc: null, schema: null, error: null });
    try {
      const list = Array.from(files);
      let fc;

      const geojson = list.find((f) => /\.(geojson|json)$/i.test(f.name));
      if (geojson) {
        fc = JSON.parse(await geojson.text());
      } else {
        // Shapefile: butuh .shp dan .dbf minimal; .prj menentukan CRS.
        // shpjs menerima ZIP atau kumpulan ArrayBuffer.
        const shp = (await import('shpjs')).default;
        const zip = list.find((f) => /\.zip$/i.test(f.name));
        if (zip) {
          fc = await shp(await zip.arrayBuffer());
        } else {
          const get = (ext) => list.find((f) => new RegExp(`\\.${ext}$`, 'i').test(f.name));
          const shpFile = get('shp');
          const dbfFile = get('dbf');
          if (!shpFile) throw new Error('Berkas .shp tidak ditemukan.');
          if (!dbfFile) throw new Error('Berkas .dbf tidak ditemukan — tabel atribut wajib ada untuk kueri.');
          fc = shp.combine([
            shp.parseShp(await shpFile.arrayBuffer(), get('prj') ? await get('prj').text() : undefined),
            shp.parseDbf(await dbfFile.arrayBuffer(), get('cpg') ? await get('cpg').text() : undefined),
          ]);
        }
      }

      if (Array.isArray(fc)) fc = { type: 'FeatureCollection', features: fc.flatMap((c) => c.features) };
      if (!fc?.features?.length) throw new Error('Tidak ada fitur di dalam berkas.');

      const schema = inferSchema(fc);
      setState({ status: 'ready', fc, schema, error: null });
    } catch (err) {
      setState({ status: 'error', fc: null, schema: null, error: err.message });
    }
  }, []);

  return { ...state, load };
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

  return (
    <div className="gt-query-builder">
      <GroupEditor node={tree} schema={schema} depth={0} t={t} onChange={setTree} />

      <div className="gt-query-result">
        <code className="gt-sql">{result?.sql}</code>
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

/* ------------------------------------------------------- lapisan terfilter */

const STYLE_MATCH = { color: '#ff2e88', weight: 2, opacity: 0.95, fillColor: '#ff2e88', fillOpacity: 0.18 };
const STYLE_DIM = { color: '#8a99908c', weight: 1, opacity: 0.25, fillColor: '#8a9990', fillOpacity: 0.04 };

export function FilteredVectorLayer({ fc, mask, mode = 'dim', onFeatureClick }) {
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
      style: () => STYLE_MATCH,
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

  // Terapkan mask tanpa membangun ulang apa pun.
  useEffect(() => {
    const idx = indexRef.current;
    if (!idx.size) return;
    if (!mask) {
      idx.forEach((lyr) => lyr.setStyle?.(STYLE_MATCH));
      return;
    }
    idx.forEach((lyr, i) => {
      const on = mask[i] === 1;
      if (mode === 'hide') {
        // Menyembunyikan lewat gaya, bukan removeLayer: menambah/menghapus
        // ribuan layer memicu perhitungan ulang indeks spasial Leaflet.
        lyr.setStyle?.(on ? STYLE_MATCH : { opacity: 0, fillOpacity: 0 });
        if (lyr._path) lyr._path.style.pointerEvents = on ? '' : 'none';
      } else {
        lyr.setStyle?.(on ? STYLE_MATCH : STYLE_DIM);
      }
    });
  }, [mask, mode]);

  return null;
}
