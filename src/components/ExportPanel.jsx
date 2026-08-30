/**
 * components/ExportPanel.jsx
 * ---------------------------------------------------------------------------
 * Satu tempat untuk seluruh keluaran.
 *
 * Sebelumnya ekspor tersebar: geometri digitasi di tab Peta, matriks konfusi di
 * tab Akurasi, dan titik validasi tidak dapat diekspor sama sekali. Di lapangan
 * itu berarti pertanyaan "sudah saya simpan belum?" tidak punya satu tempat
 * untuk dijawab.
 *
 * Panel ini menjawabnya sekaligus: apa yang ada, berapa banyak, dan dalam
 * bentuk apa ia bisa keluar.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useLocale } from '../context/AppProviders.jsx';
import { exportKML, exportSamplesGeoJSON } from '../core/export/kml.js';
import { buildAccuracyWorkbook } from '../core/export/xlsx.js';
import { downloadBlob } from '../core/export/zip.js';
import { downloadGeoJSON } from './DrawingTools.jsx';

const stamp = () => {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

export function ExportPanel({ samples, drawnFeatures, cm, metrics, binary }) {
  const { t, nf } = useLocale();
  const [busy, setBusy] = useState(null);
  const [last, setLast] = useState(null);

  const photoCount = useMemo(
    () => samples.reduce((a, s) => a + (s.photos?.length ?? 0), 0),
    [samples]
  );
  const drawnCount = drawnFeatures?.features?.length ?? 0;

  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setLast(null);
    try {
      const msg = await fn();
      setLast({ ok: true, msg });
    } catch (e) {
      setLast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }, []);

  const exportPoints = () => run('kml', async () => {
    const r = exportKML(samples, { basename: `REIS_titik_${stamp()}` });
    await downloadBlob(r.blob, r.filename);
    return r.kind === 'kmz'
      ? t('export.doneKMZ', { n: samples.length, f: r.photos })
      : t('export.doneKML', { n: samples.length });
  });

  const exportPointsGeoJSON = () => run('gj', async () => {
    const r = exportSamplesGeoJSON(samples);
    await downloadBlob(r.blob, `REIS_titik_${stamp()}.geojson`);
    return t('export.doneGeoJSON', { n: r.count });
  });

  const exportWorkbook = () => run('xlsx', async () => {
    const blob = buildAccuracyWorkbook({ cm, metrics, samples, binary });
    await downloadBlob(blob, `REIS_akurasi_${stamp()}.xlsx`);
    return t('export.doneXLSX');
  });

  const exportDrawing = () => run('draw', async () => {
    await downloadGeoJSON(drawnFeatures, `REIS_digitasi_${stamp()}.geojson`);
    return t('export.doneGeoJSON', { n: drawnCount });
  });

  return (
    <div className="gt-export">
      <section className="gt-export-group">
        <h4>{t('export.points')}</h4>
        <p className="gt-export-count">
          <strong>{nf(samples.length, 0)}</strong> {t('export.pointsUnit')}
          {photoCount > 0 && <> · {nf(photoCount, 0)} {t('export.photos')}</>}
        </p>

        <button type="button" className="gt-btn-primary"
          disabled={!samples.length || busy} onClick={exportPoints}>
          {busy === 'kml' ? t('export.working') : (photoCount > 0 ? 'KMZ' : 'KML')}
        </button>
        <p className="gt-hint">
          {photoCount > 0 ? t('export.kmzNote') : t('export.kmlNote')}
        </p>

        <button type="button" disabled={!samples.length || busy}
          onClick={exportPointsGeoJSON}>
          {busy === 'gj' ? t('export.working') : 'GeoJSON'}
        </button>
        <p className="gt-hint">{t('export.geojsonNote')}</p>
      </section>

      <section className="gt-export-group">
        <h4>{t('export.accuracy')}</h4>
        <p className="gt-export-count">
          {metrics
            ? <>OA <strong>{nf(metrics.overallAccuracy * 100, 2)}%</strong> · {metrics.total} {t('export.pointsUnit')}</>
            : t('export.binaryOnly')}
        </p>
        <button type="button" className="gt-btn-primary"
          disabled={!samples.length || busy} onClick={exportWorkbook}>
          {busy === 'xlsx' ? t('export.working') : 'XLSX'}
        </button>
        <p className="gt-hint">{t('export.xlsxNote')}</p>
      </section>

      {drawnCount > 0 && (
        <section className="gt-export-group">
          <h4>{t('export.drawing')}</h4>
          <p className="gt-export-count">
            <strong>{nf(drawnCount, 0)}</strong> {t('layers.features')}
          </p>
          <button type="button" disabled={busy} onClick={exportDrawing}>
            {busy === 'draw' ? t('export.working') : 'GeoJSON'}
          </button>
        </section>
      )}

      {last && (
        <p className={last.ok ? 'gt-export-ok' : 'gt-gps-alert'} role="status">
          {last.msg}
        </p>
      )}

      <p className="gt-hint gt-export-warn">{t('export.storageWarn')}</p>
    </div>
  );
}
