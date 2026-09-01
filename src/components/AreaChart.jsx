/**
 * components/AreaChart.jsx
 * ---------------------------------------------------------------------------
 * Diagram luas menurut kelas atribut.
 *
 * MENGAPA LUAS, BUKAN JUMLAH FITUR
 * --------------------------------
 * Menghitung fitur menjawab "berapa banyak poligon", yang jarang menjadi
 * pertanyaan sebenarnya. Pada peta tutupan lahan, satu poligon sawah seluas
 * 200 hektar dan satu poligon permukiman seluas 2 hektar dihitung sama — dan
 * kesimpulannya jadi terbalik dari kenyataan.
 *
 * Luas dihitung geodesik di atas elipsoid dan sudah memperhitungkan lubang
 * poligon, jadi angkanya dapat langsung dipakai untuk pelaporan.
 */

import React, { useMemo } from 'react';
import { useLocale } from '../context/AppProviders.jsx';
import { areaByClass } from '../core/vector/area.js';
import { formatArea } from '../core/geo/measure.js';

export function AreaByClassChart({ fc, field, colors, mask }) {
  const { t, locale, nf } = useLocale();

  const { rows, total, hasArea } = useMemo(
    () => areaByClass(fc, field, mask), [fc, field, mask]);

  if (!hasArea) return <p className="gt-hint">{t('area.noPolygon')}</p>;
  if (!field) return <p className="gt-hint">{t('area.pickField')}</p>;

  return (
    <div className="gt-areachart">
      <div className="gt-area-total">
        <span>{t('area.total')}</span>
        <strong className="mono">{formatArea(total, locale)}</strong>
      </div>

      {rows.map((r) => {
        const label = r.value === '' ? t('area.blank') : r.value;
        const warna = colors?.[r.value] ?? 'var(--muted)';
        return (
          <div key={r.value} className="gt-area-row">
            <div className="gt-area-head">
              <span className="gt-area-sw" style={{ background: warna }} />
              <span className="gt-area-label" title={label}>{label}</span>
              <span className="mono gt-area-pct">{nf(r.share * 100, 1)}%</span>
            </div>
            <div className="gt-area-track">
              <div className="gt-area-fill"
                style={{ width: `${Math.max(r.share * 100, 0.4)}%`, background: warna }} />
            </div>
            <div className="gt-area-meta mono">
              {formatArea(r.area, locale)} · {nf(r.count, 0)} {t('layers.features')}
            </div>
          </div>
        );
      })}

      <p className="gt-hint">{t('area.note')}</p>
    </div>
  );
}
