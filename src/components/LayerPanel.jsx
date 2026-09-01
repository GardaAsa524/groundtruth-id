/**
 * components/LayerPanel.jsx
 * ---------------------------------------------------------------------------
 * Panel Lapisan — satu tempat untuk semua data yang sedang tampil.
 *
 * PERUBAHAN DARI VERSI SEBELUMNYA
 * -------------------------------
 * Versi lama hanya berupa daftar datar: centang, zoom, hapus. Simbologi dan
 * penyaring atribut hidup di tab lain, sehingga untuk mengubah warna satu
 * lapisan surveyor harus pindah tab dan kehilangan konteks daftar.
 *
 * Sekarang tiap lapisan adalah satu kartu yang bisa dibuka. Di dalamnya ada
 * tiga bagian — Simbologi, Penyaring, Tabel — persis seperti panel Contents di
 * ArcGIS dan Layers di QGIS, sehingga pengguna yang datang dari sana tidak
 * perlu belajar ulang.
 *
 * URUTAN MEMAKAI TOMBOL, BUKAN SERET
 * ----------------------------------
 * Seret-lepas gagal di lapangan: layar basah, sarung tangan, dan satu tangan
 * memegang alat. Tombol ▲▼ memindahkan lapisan satu langkah — lambat, tetapi
 * tidak pernah salah lepas.
 *
 * KELAS BISA DIMATIKAN SATU-SATU
 * ------------------------------
 * Mematikan satu kelas legenda menyembunyikan fiturnya dari peta. Inilah cara
 * tercepat memeriksa satu kelas tunggal tanpa menulis kueri.
 */

import React, { useState } from 'react';
import { useLocale } from '../context/AppProviders.jsx';
import '../styles/layer-panel.css';

const KIND_LABEL = {
  geopdf: 'GeoPDF',
  raster: 'Raster',
  vector: 'Vektor',
  samples: 'Titik validasi',
  drawing: 'Digitasi',
  track: 'Jejak',
};

const SECTIONS = [
  ['sym', 'layers.symbology', 'Simbologi'],
  ['filter', 'layers.filter', 'Penyaring'],
  ['table', 'layers.table', 'Tabel'],
  ['area', 'layers.area', 'Luas'],
];

/* ========================================================================= */
/*  Legenda dengan sakelar per kelas                                          */
/* ========================================================================= */

/**
 * @param {Array} entries hasil legendEntries() dari core/vector/style.js
 * @param {object} off    { [value]: true } kelas yang sedang disembunyikan
 * @param {(value:string)=>void} onToggle
 */
export function LegendList({ entries, off = {}, onToggle, nf }) {
  if (!entries?.length) return null;

  return (
    <div className="gt-lp-legend">
      {entries.map((e) => {
        const on = !off[e.value];
        return (
          <label key={e.value} className={`gt-lp-legend-row${on ? '' : ' is-off'}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle?.(e.value)}
            />
            <span
              className="gt-lp-swatch"
              style={on
                ? { background: e.color }
                : { boxShadow: `inset 0 0 0 1px ${e.color}` }}
            />
            <span className="gt-lp-legend-label">{e.label}</span>
            <span className="mono gt-lp-legend-count">
              {nf ? nf(e.count, 0) : e.count}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/* ========================================================================= */
/*  Tabel atribut ringkas                                                     */
/* ========================================================================= */

/**
 * Hanya beberapa baris pertama. Tabel penuh bukan tujuan panel ini — yang
 * dibutuhkan di lapangan adalah memastikan kolomnya benar sebelum menyaring.
 */
export function MiniAttributeTable({ fc, columns, limit = 8, onRowClick, nf }) {
  const feats = fc?.features ?? [];
  if (!feats.length) return null;

  const cols = columns?.length
    ? columns
    : Object.keys(feats[0].properties ?? {}).slice(0, 3);

  return (
    <>
      <table className="gt-lp-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {feats.slice(0, limit).map((f, i) => (
            <tr key={i} onClick={() => onRowClick?.(f)}>
              {cols.map((c) => (
                <td key={c} className="mono">{String(f.properties?.[c] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gt-hint">
        {Math.min(limit, feats.length)} dari {nf ? nf(feats.length, 0) : feats.length} baris
        {onRowClick ? ' · ketuk baris untuk zoom ke fitur' : ''}
      </p>
    </>
  );
}

/* ========================================================================= */
/*  Kartu satu lapisan                                                        */
/* ========================================================================= */

function LayerCard({
  layer: l, index, total, t, nf,
  open, section, onExpand, onSection,
  onChange, onZoom, onRemove, onReorder, onCancel,
  renderSection,
}) {
  /* Lapisan yang sedang dibaca dari berkas tampil sebagai kartu progres.
     Ia belum punya geometri, jadi tidak ada yang bisa dicentang atau diurut. */
  if (l.status === 'loading') {
    return (
      <div className="gt-lp-card is-loading">
        <div className="gt-lp-head">
          <span className="gt-lp-spinner" aria-hidden="true" />
          <div className="gt-lp-title">
            <span className="gt-lp-name" title={l.name}>{l.name}</span>
            <span className="gt-lp-meta">{l.note ?? t('layers.parsing')}</span>
          </div>
          {Number.isFinite(l.progress) && (
            <span className="mono gt-lp-pct">{Math.round(l.progress * 100)}%</span>
          )}
        </div>
        <div className="gt-lp-bar" role="progressbar"
          aria-valuenow={Math.round((l.progress ?? 0) * 100)}>
          <div style={{ width: `${Math.round((l.progress ?? 0) * 100)}%` }} />
        </div>
        {onCancel && (
          <button type="button" className="gt-lp-cancel" onClick={() => onCancel(l.id)}>
            {t('layers.cancel')}
          </button>
        )}
      </div>
    );
  }

  const expandable = l.kind === 'vector' || l.legend?.length;

  return (
    <div className={`gt-lp-card${open ? ' is-open' : ''}${l.visible ? '' : ' is-hidden'}`}>
      <div className="gt-lp-head">
        <input
          type="checkbox"
          className="gt-lp-check"
          checked={l.visible}
          aria-label={l.name}
          onChange={(e) => onChange(l.id, { visible: e.target.checked })}
        />

        <button
          type="button"
          className="gt-lp-title"
          aria-expanded={open}
          onClick={() => onExpand(open ? null : l.id)}
        >
          <span className="gt-lp-name" title={l.name}>{l.name}</span>
          <span className="gt-lp-meta">
            <span className="gt-lp-kind">{KIND_LABEL[l.kind] ?? l.kind}</span>
            {Number.isFinite(l.count) && (
              <span className="mono">{nf(l.count, 0)} {t('layers.features')}</span>
            )}
          </span>
        </button>

        {/* Urutan: atas = paling depan di peta. */}
        <div className="gt-lp-move">
          <button type="button" title={t('layers.moveUp')} disabled={index === 0}
            onClick={() => onReorder?.(l.id, -1)}>▲</button>
          <button type="button" title={t('layers.moveDown')} disabled={index === total - 1}
            onClick={() => onReorder?.(l.id, 1)}>▼</button>
        </div>

        <button
          type="button"
          className={`gt-lp-chev${open ? ' is-open' : ''}`}
          aria-label={open ? t('layers.collapse') : t('layers.expand')}
          onClick={() => onExpand(open ? null : l.id)}
        >
          ▾
        </button>
      </div>

      {open && (
        <div className="gt-lp-body">
          {expandable && (
            <div className="gt-lp-tabs" role="tablist">
              {SECTIONS.map(([k, key, fallback]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={section === k}
                  className={section === k ? 'is-on' : ''}
                  onClick={() => onSection(k)}
                >
                  {t(key) === key ? fallback : t(key)}
                </button>
              ))}
            </div>
          )}

          {/* Isi tiap bagian datang dari App: SymbologyPanel,
              AttributeQueryBuilder, dan tabel atribut tetap tinggal di
              tempatnya masing-masing supaya tidak ada logika yang diduplikasi. */}
          <div className="gt-lp-section">
            {renderSection?.(l, expandable ? section : 'sym')}
          </div>

          <div className="gt-lp-actions">
            <button type="button" className="gt-lp-zoom"
              disabled={!l.bounds} onClick={() => l.bounds && onZoom(l.bounds)}>
              ⤢ {t('layers.zoomTo')}
            </button>
            {l.opacity !== undefined && (
              <label className="gt-lp-opacity">
                {t('raster.opacity')} {Math.round(l.opacity * 100)}%
                <input type="range" min="0" max="1" step="0.05" value={l.opacity}
                  onChange={(e) => onChange(l.id, { opacity: parseFloat(e.target.value) })} />
              </label>
            )}
            {l.removable !== false && (
              <button type="button" className="gt-icon-btn" title={t('layers.remove')}
                onClick={() => onRemove(l.id)}>×</button>
            )}
          </div>

          {l.note && <p className="gt-lp-note">{l.note}</p>}
        </div>
      )}
    </div>
  );
}

/* ========================================================================= */
/*  Panel                                                                     */
/* ========================================================================= */

/**
 * @param {Array}  layers      [{ id, kind, name, visible, opacity, bounds, count,
 *                               note, removable, status, progress }]
 *                             status 'loading' + progress 0..1 menampilkan kartu progres.
 * @param {(id:string, patch:object)=>void} onChange
 * @param {(bounds:number[][])=>void}       onZoom
 * @param {(id:string)=>void}               onRemove
 * @param {(id:string, delta:number)=>void} onReorder   ▲▼; hilangkan untuk mengunci urutan
 * @param {(id:string)=>void}               onCancel    batalkan pembacaan berkas
 * @param {(layer:object, section:string)=>React.ReactNode} renderSection
 * @param {()=>void}  onPickFile  aksi utama pada keadaan kosong
 * @param {number}    pendingCount  jumlah kartu rangka saat berkas antre dibaca
 */
export function LayerPanel({
  layers = [],
  onChange, onZoom, onRemove, onReorder, onCancel,
  renderSection, onPickFile, pendingCount = 0,
}) {
  const { t, nf } = useLocale();
  const [open, setOpen] = useState(null);
  const [section, setSection] = useState('sym');

  if (!layers.length && !pendingCount) {
    return (
      <div className="gt-lp-empty">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M24 6 42 15 24 24 6 15Z" />
            <path d="M6 24l18 9 18-9" />
            <path d="M6 33l18 9 18-9" />
          </g>
        </svg>
        <p className="gt-lp-empty-title">{t('layers.emptyTitle')}</p>
        <p className="gt-hint">{t('layers.empty')}</p>
        {onPickFile && (
          <button type="button" className="gt-btn-primary" onClick={onPickFile}>
            {t('layers.pickFile')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="gt-lp">
      <h3 className="gt-layers-title">
        {t('layers.title')} · {nf(layers.length, 0)}
      </h3>

      {layers.map((l, i) => (
        <LayerCard
          key={l.id}
          layer={l}
          index={i}
          total={layers.length}
          t={t}
          nf={nf}
          open={open === l.id}
          section={section}
          onExpand={setOpen}
          onSection={setSection}
          onChange={onChange}
          onZoom={onZoom}
          onRemove={onRemove}
          onReorder={onReorder}
          onCancel={onCancel}
          renderSection={renderSection}
        />
      ))}

      {/* Kartu rangka: memberi tahu bahwa masih ada berkas yang akan muncul,
          sehingga daftar tidak terlihat "sudah selesai" padahal belum. */}
      {Array.from({ length: pendingCount }, (_, i) => (
        <div key={`skel${i}`} className="gt-lp-skel" aria-hidden="true">
          <span className="gt-lp-skel-box" />
          <span className="gt-lp-skel-lines">
            <span style={{ width: '62%' }} />
            <span style={{ width: '34%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}
