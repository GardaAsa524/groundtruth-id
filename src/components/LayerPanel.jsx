/**
 * components/LayerPanel.jsx
 * ---------------------------------------------------------------------------
 * Daftar lapisan aktif, meniru panel Contents di ArcGIS.
 *
 * MENGAPA INI PERLU ADA
 * ---------------------
 * Sebelumnya setiap lapisan hanya dapat dikendalikan dari tab tempat ia dimuat.
 * Akibatnya tidak ada satu tempat pun untuk menjawab tiga pertanyaan yang
 * paling sering muncul saat bekerja: apa saja yang sedang tampil, mana yang
 * menutupi mana, dan di mana letaknya di peta.
 *
 * "Zoom ke lapisan" khususnya bukan kemewahan. Ketika data yang dimuat berada
 * di CRS yang salah atau di belahan bumi lain, tombol inilah yang paling cepat
 * menunjukkannya — jauh lebih cepat daripada menggeser peta menebak-nebak.
 */

import React from 'react';
import { useLocale } from '../context/AppProviders.jsx';

const KIND_LABEL = {
  geopdf: 'GeoPDF',
  raster: 'Raster',
  vector: 'Vektor',
  samples: 'Titik validasi',
  drawing: 'Digitasi',
};

/**
 * @param {Array} layers  [{ id, kind, name, visible, opacity, bounds, count, note }]
 * @param {(id:string, patch:object)=>void} onChange
 * @param {(bounds:number[][])=>void} onZoom
 * @param {(id:string)=>void} onRemove
 */
export function LayerPanel({ layers, onChange, onZoom, onRemove }) {
  const { t, nf } = useLocale();

  if (!layers.length) {
    return <p className="gt-hint">{t('layers.empty')}</p>;
  }

  return (
    <div className="gt-layers">
      <h3 className="gt-layers-title">{t('layers.title')}</h3>

      {layers.map((l) => (
        <div key={l.id} className={`gt-layer${l.visible ? '' : ' is-hidden'}`}>
          <div className="gt-layer-row">
            <label className="gt-layer-check">
              <input
                type="checkbox"
                checked={l.visible}
                onChange={(e) => onChange(l.id, { visible: e.target.checked })}
              />
              <span className="gt-layer-name" title={l.name}>{l.name}</span>
            </label>

            <button
              type="button"
              className="gt-icon-btn"
              title={t('layers.zoomTo')}
              disabled={!l.bounds}
              onClick={() => l.bounds && onZoom(l.bounds)}
            >
              ⤢
            </button>

            {l.removable !== false && (
              <button
                type="button"
                className="gt-icon-btn"
                title={t('layers.remove')}
                onClick={() => onRemove(l.id)}
              >
                ×
              </button>
            )}
          </div>

          <div className="gt-layer-meta">
            <span className="gt-layer-kind">{KIND_LABEL[l.kind] ?? l.kind}</span>
            {Number.isFinite(l.count) && (
              <span className="mono">{nf(l.count, 0)} {t('layers.features')}</span>
            )}
            {l.note && <span className="gt-layer-note">{l.note}</span>}
          </div>

          {l.opacity !== undefined && l.visible && (
            <input
              className="gt-layer-opacity"
              type="range" min="0" max="1" step="0.05"
              value={l.opacity}
              title={`${t('raster.opacity')} ${Math.round(l.opacity * 100)}%`}
              onChange={(e) => onChange(l.id, { opacity: parseFloat(e.target.value) })}
            />
          )}
        </div>
      ))}
    </div>
  );
}
