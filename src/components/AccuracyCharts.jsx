/**
 * components/AccuracyCharts.jsx
 * ---------------------------------------------------------------------------
 * Visualisasi hasil uji akurasi: matriks konfusi berwarna dan grafik batang
 * per kelas.
 *
 * DIGAMBAR SEBAGAI SVG, TANPA PUSTAKA GRAFIK
 * ------------------------------------------
 * Chart.js dan Recharts masing-masing menambah 60-90 kB tergzip ke bundel yang
 * harus diunduh setiap surveyor. Untuk dua bagan yang bentuknya sudah pasti
 * dan tidak perlu interaktif, itu tidak sepadan. SVG langsung juga membuat
 * warnanya mengikuti tema lewat variabel CSS, yang tidak dilakukan pustaka
 * grafik tanpa konfigurasi tambahan.
 */

import React, { useMemo } from 'react';
import { useLocale } from '../context/AppProviders.jsx';

/**
 * Warna sel matriks: biru untuk diagonal (benar), merah untuk luar diagonal
 * (salah). Memakai satu gradien untuk keduanya membuat kesalahan besar dan
 * kebenaran besar tampak serupa — persis yang tidak boleh terjadi pada bagan
 * yang tujuannya menunjukkan letak kesalahan.
 */
function cellColor(value, max, isDiagonal) {
  if (value === 0) return 'transparent';
  const t = max > 0 ? Math.min(1, value / max) : 0;
  const alpha = 0.12 + t * 0.78;
  return isDiagonal
    ? `rgba(46, 125, 82, ${alpha})`
    : `rgba(200, 40, 70, ${alpha})`;
}

export function ConfusionMatrixChart({ cm, metrics }) {
  const { t, nf } = useLocale();
  if (!cm || !metrics) return null;

  const { classes, matrix } = cm;
  const n = classes.length;
  const maxOff = useMemo(() => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (i !== j) m = Math.max(m, matrix[i][j]);
    }
    return m;
  }, [matrix, n]);
  const maxDiag = useMemo(
    () => Math.max(...classes.map((_, i) => matrix[i][i])), [matrix, classes]);

  // Label kelas dipendekkan; nama tutupan lahan sering panjang dan akan
  // saling bertindih pada layar ponsel.
  const short = (s) => (s.length > 9 ? `${s.slice(0, 8)}…` : s);

  return (
    <div className="gt-chart">
      <h4 className="gt-chart-title">{t('chart.matrixTitle')}</h4>
      <p className="gt-chart-sub">{t('chart.matrixSub')}</p>

      <div className="gt-matrix-grid" style={{ '--cols': n }}>
        <div className="gt-mx-corner" />
        {classes.map((c) => (
          <div key={`h${c}`} className="gt-mx-head" title={c}>{short(c)}</div>
        ))}

        {classes.map((rowName, i) => (
          <React.Fragment key={rowName}>
            <div className="gt-mx-rowhead" title={rowName}>{short(rowName)}</div>
            {classes.map((colName, j) => {
              const v = matrix[i][j];
              const diag = i === j;
              return (
                <div key={colName} className={`gt-mx-cell${diag ? ' is-diag' : ''}`}
                  style={{ background: cellColor(v, diag ? maxDiag : maxOff, diag) }}
                  title={`${t('chart.map')}: ${rowName} → ${t('chart.field')}: ${colName} = ${v}`}>
                  {v > 0 ? v : ''}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>

      <div className="gt-chart-legend">
        <span><i className="gt-sw is-ok" /> {t('chart.correct')}</span>
        <span><i className="gt-sw is-bad" /> {t('chart.wrong')}</span>
      </div>
    </div>
  );
}

/**
 * Grafik batang User's dan Producer's Accuracy per kelas.
 *
 * Menampilkan keduanya berdampingan, bukan salah satu, karena keduanya dapat
 * bergerak berlawanan: kelas yang jarang dipetakan bisa punya User's Accuracy
 * tinggi sekaligus Producer's Accuracy rendah. Menampilkan satu saja
 * menyembunyikan separuh cerita.
 */
export function ClassAccuracyChart({ metrics }) {
  const { t, nf } = useLocale();
  if (!metrics?.perClass?.length) return null;

  const rows = metrics.perClass;
  const W = 300;
  const rowH = 34;
  const labelW = 78;
  const barW = W - labelW - 42;
  const H = rows.length * rowH + 26;

  return (
    <div className="gt-chart">
      <h4 className="gt-chart-title">{t('chart.classTitle')}</h4>
      <p className="gt-chart-sub">{t('chart.classSub')}</p>

      <svg viewBox={`0 0 ${W} ${H}`} className="gt-bars" role="img"
        aria-label={t('chart.classTitle')}>
        {/* Garis bantu 50% dan 100% memberi acuan baca; tanpa itu, panjang
            batang hanya dapat dibandingkan satu sama lain, bukan terhadap
            ambang mutu yang biasa dipakai. */}
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={labelW + barW * f} y1={14} x2={labelW + barW * f} y2={H - 12}
              className="gt-bar-grid" />
            <text x={labelW + barW * f} y={10} className="gt-bar-gridlabel">
              {f * 100}%
            </text>
          </g>
        ))}

        {rows.map((c, i) => {
          const y = 20 + i * rowH;
          const ua = Number.isFinite(c.usersAccuracy) ? c.usersAccuracy : 0;
          const pa = Number.isFinite(c.producersAccuracy) ? c.producersAccuracy : 0;
          return (
            <g key={c.name}>
              <text x={0} y={y + 12} className="gt-bar-label">
                {c.name.length > 10 ? `${c.name.slice(0, 9)}…` : c.name}
              </text>
              <rect x={labelW} y={y} width={Math.max(1, barW * ua)} height={9}
                rx={2} className="gt-bar-ua" />
              <rect x={labelW} y={y + 12} width={Math.max(1, barW * pa)} height={9}
                rx={2} className="gt-bar-pa" />
              <text x={labelW + barW + 4} y={y + 8} className="gt-bar-value">
                {nf(ua * 100, 0)}
              </text>
              <text x={labelW + barW + 4} y={y + 20} className="gt-bar-value">
                {nf(pa * 100, 0)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="gt-chart-legend">
        <span><i className="gt-sw is-ua" /> {t('accuracy.ua')}</span>
        <span><i className="gt-sw is-pa" /> {t('accuracy.pa')}</span>
      </div>
    </div>
  );
}

/**
 * Ringkasan sebaran sesuai/tidak sesuai sebagai batang tunggal.
 * Berguna ketika kelas rujukan belum lengkap dan matriks belum dapat dibangun.
 */
export function AgreementBar({ samples }) {
  const { t, nf } = useLocale();
  const total = samples.length;
  if (!total) return null;
  const benar = samples.filter((s) => s.isCorrect).length;
  const pct = (benar / total) * 100;

  return (
    <div className="gt-agree">
      <div className="gt-agree-bar">
        <div className="gt-agree-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="gt-agree-meta">
        <span className="is-ok">{benar} {t('validation.truth').toLowerCase()}</span>
        <span className="mono">{nf(pct, 1)}%</span>
        <span className="is-bad">{total - benar} {t('validation.false').toLowerCase()}</span>
      </div>
    </div>
  );
}
