/**
 * App.jsx
 * ---------------------------------------------------------------------------
 * Komponen utama GroundTruth.id — tempat seluruh modul bertemu.
 *
 * PETA ALIRAN DATA
 * ----------------
 *
 *   Perangkat keras                Pengolahan di klien              Tampilan
 *   ---------------                -------------------              --------
 *   chip GNSS
 *     └ Geolocation API ─→ useGeolocation ─→ lat/lon + accuracy ─┬→ GPSAccuracyLayer
 *                                                                 ├→ GPSReadout
 *                                                                 └→ formulir sampel
 *   Berkas pengguna
 *     ├ GeoPDF ─→ pdf-lib (georeferensi) ─┐
 *     │           pdf.js (piksel)         ├→ buildGeoref ─→ GeoPDFGridLayer
 *     │                                    └→ panel mutu (RMSE, konvergensi)
 *     ├ GeoTIFF ─→ geotiff.js ─→ Float32Array/pita ─→ RasterGLRenderer ─→ overlay
 *     │                            ↑
 *     │              parseExpression → AST → emitGLSL (shader)
 *     └ GeoJSON/SHP ─→ inferSchema ─→ AttributeQueryBuilder ─→ bitmask
 *                                                              └→ FilteredVectorLayer
 *   Digitasi
 *     └ Geoman ─→ FeatureCollection ─→ downloadGeoJSON / webhook Sheets
 *
 *   Validasi
 *     └ sakelar Truth/False + kelas ─→ sampel ─→ confusionMatrix ─→ OA/F1/Kappa
 *
 * Titik penting: satu-satunya keadaan yang dibagikan lintas modul adalah
 * ProjectContext. Modul tidak saling mengimpor; mereka bertemu di sini.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { MapContainer, ScaleControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { AppProviders, useTheme, useLocale, useProject } from './context/AppProviders.jsx';
import { useGeolocation } from './hooks/useGeolocation.js';
import { ActiveBasemap, BasemapGallery, InvalidateOnResize } from './components/BasemapGallery.jsx';
import { GPSAccuracyLayer, GPSReadout } from './components/GPSAccuracyLayer.jsx';
import { useGeoPDF, GeoPDFLayer, GeoPDFQualityPanel } from './components/GeoPDFLayer.jsx';
import { useGeoTIFF, RasterCalculator, RasterResultLayer } from './components/RasterCalculator.jsx';
import {
  useVectorFile, AttributeQueryBuilder, FilteredVectorLayer,
} from './components/AttributeQueryBuilder.jsx';
import { DrawingTools, ExportButton } from './components/DrawingTools.jsx';
import { forwardUTM, utmZoneFromLon } from './core/geo/projection.js';
import {
  buildMatrix, computeMetrics, computeBinaryValidation, matrixToCSV,
} from './core/accuracy/confusionMatrix.js';

const TABS = ['map', 'raster', 'query', 'accuracy', 'settings'];

function Workspace() {
  const { t, nf, toggle: toggleLocale } = useLocale();
  const { isDark, toggle: toggleTheme, suggestedBasemap } = useTheme();
  const { samples, setSamples, drawnFeatures, setDrawnFeatures } = useProject();

  const [tab, setTab] = useState('map');
  const [basemap, setBasemap] = useState(suggestedBasemap);
  const [allowGoogle, setAllowGoogle] = useState(false);
  const [follow, setFollow] = useState(true);
  const [pdfOpacity, setPdfOpacity] = useState(1);
  const [rasterResult, setRasterResult] = useState(null);
  const [rasterGeom, setRasterGeom] = useState(null);
  const [queryResult, setQueryResult] = useState(null);
  const [filterMode, setFilterMode] = useState('dim');

  const geo = useGeolocation({ toleranceMeters: 15 });
  const pdf = useGeoPDF();
  const tiff = useGeoTIFF();
  const vector = useVectorFile();

  // Koordinat UTM dari fix GPS — ditampilkan berdampingan dengan lat/lon karena
  // sebagian besar data lapangan di Indonesia dikelola dalam UTM.
  const utm = useMemo(() => {
    const p = geo.position;
    if (!p) return null;
    const zone = utmZoneFromLon(p.lon);
    const r = forwardUTM(p.lat, p.lon, { zone, south: p.lat < 0 });
    return { ...r, label: `UTM ${zone}${p.lat < 0 ? 'S' : 'N'}` };
  }, [geo.position]);

  /* ---------------------------------------------------- perekaman sampel */

  const recordSample = useCallback((verdict, predictedClass, actualClass) => {
    const p = geo.position;
    if (!p) return;
    setSamples((prev) => [...prev, {
      id: `s${Date.now()}`,
      lat: p.lat, lon: p.lon,
      accuracy: p.accuracy,
      // Jejak mutu ikut disimpan: saat menulis laporan, pertanyaan pertama
      // reviewer adalah seberapa teliti posisi sampelnya.
      accuracyFlagged: p.accuracy > geo.toleranceMeters,
      predicted: predictedClass,
      actual: verdict ? predictedClass : actualClass,
      isCorrect: verdict,
      timestamp: new Date().toISOString(),
    }]);
  }, [geo.position, geo.toleranceMeters, setSamples]);

  /* ------------------------------------------------------------- metrik */

  const metrics = useMemo(() => {
    const withActual = samples.filter((s) => s.actual);
    if (withActual.length < 2) return null;
    const cm = buildMatrix(withActual);
    return { cm, ...computeMetrics(cm) };
  }, [samples]);

  const binary = useMemo(() => computeBinaryValidation(samples), [samples]);

  const exportCSV = useCallback(() => {
    if (!metrics) return;
    const blob = new Blob([matrixToCSV(metrics.cm, metrics)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `GroundTruth_matriks_${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [metrics]);

  /* --------------------------------------------------------------- render */

  return (
    <div className="gt-app" data-theme={isDark ? 'dark' : 'light'}>
      <header className="gt-header">
        <div>
          <h1>{t('app.title')}</h1>
          <p>{t('app.subtitle')} · MangGIS.co</p>
        </div>
        <div className="gt-header-actions">
          <button type="button" onClick={toggleLocale}>{t('locale.toggle')}</button>
          <button type="button" onClick={toggleTheme} aria-label={t('theme.toggle')}>
            {isDark ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="gt-body">
        <aside className="gt-sidebar">
          <nav className="gt-tabs">
            {TABS.map((k) => (
              <button key={k} type="button"
                className={tab === k ? 'is-on' : ''}
                onClick={() => setTab(k)}>{t(`nav.${k}`)}</button>
            ))}
          </nav>

          <div className="gt-panel">
            {tab === 'map' && (
              <>
                <GPSReadout geo={geo} utm={utm} />
                <div className="gt-row">
                  <button type="button" onClick={geo.status === 'active' ? geo.stop : geo.start}>
                    {geo.status === 'active' ? 'Stop GPS' : 'Mulai GPS'}
                  </button>
                  <label className="gt-check">
                    <input type="checkbox" checked={follow}
                      onChange={(e) => setFollow(e.target.checked)} />
                    Ikuti posisi
                  </label>
                </div>

                <hr />
                <label className="gt-field">
                  GeoPDF
                  <input type="file" accept="application/pdf"
                    onChange={(e) => e.target.files[0] && pdf.load(e.target.files[0])} />
                </label>
                {pdf.status === 'error' && <p className="gt-gps-alert">{pdf.error}</p>}
                {pdf.doc && (
                  <>
                    <GeoPDFQualityPanel doc={pdf.doc} t={t} nf={nf} />
                    <label className="gt-slider">
                      Transparansi {Math.round(pdfOpacity * 100)}%
                      <input type="range" min="0" max="1" step="0.05" value={pdfOpacity}
                        onChange={(e) => setPdfOpacity(parseFloat(e.target.value))} />
                    </label>
                  </>
                )}

                <hr />
                <DrawingTools onChange={setDrawnFeatures} />
                <ExportButton featureCollection={drawnFeatures} />

                <hr />
                <BasemapGallery value={basemap} onChange={setBasemap} allowGoogle={allowGoogle} />
              </>
            )}

            {tab === 'raster' && (
              <>
                <label className="gt-field">
                  GeoTIFF
                  <input type="file" accept=".tif,.tiff"
                    onChange={(e) => e.target.files[0] && tiff.load(e.target.files[0])} />
                </label>
                {tiff.status === 'error' && <p className="gt-gps-alert">{tiff.error}</p>}
                <RasterCalculator tiff={tiff.data} onLayerReady={setRasterResult} />
                {rasterGeom && !rasterGeom.ok && (
                  <p className="gt-gps-alert" role="alert">{rasterGeom.error}</p>
                )}
                {rasterGeom?.ok && (
                  <dl className="gt-quality">
                    <div>
                      <dt>{t('raster.placement')}</dt>
                      <dd className="mono">
                        {rasterGeom.reprojected
                          ? `UTM ${rasterGeom.crs.zone}${rasterGeom.crs.south ? 'S' : 'N'} → WGS 84`
                          : 'EPSG:4326'}
                      </dd>
                    </div>
                    {rasterGeom.reprojected && (
                      <div>
                        <dt>{t('raster.overlaySkew')}</dt>
                        <dd className={rasterGeom.warn ? 'is-warning mono' : 'mono'}>
                          ±{nf(rasterGeom.skewMeters, 1)} m
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                {rasterGeom?.warn && (
                  <p className="gt-hint">{t('raster.skewWarn', { m: nf(rasterGeom.skewMeters, 0) })}</p>
                )}
              </>
            )}

            {tab === 'query' && (
              <>
                <label className="gt-field">
                  GeoJSON / Shapefile
                  <input type="file" multiple accept=".geojson,.json,.zip,.shp,.dbf,.prj,.cpg"
                    onChange={(e) => e.target.files.length && vector.load(e.target.files)} />
                </label>
                {vector.status === 'error' && <p className="gt-gps-alert">{vector.error}</p>}
                <div className="gt-seg">
                  {['dim', 'hide'].map((m) => (
                    <button key={m} type="button" className={filterMode === m ? 'is-on' : ''}
                      onClick={() => setFilterMode(m)}>{m === 'dim' ? 'Redupkan' : 'Sembunyikan'}</button>
                  ))}
                </div>
                <AttributeQueryBuilder fc={vector.fc} schema={vector.schema} onResult={setQueryResult} />
              </>
            )}

            {tab === 'accuracy' && (
              <AccuracyPanel
                metrics={metrics} binary={binary} samples={samples}
                onExport={exportCSV} t={t} nf={nf}
              />
            )}

            {tab === 'settings' && (
              <div className="gt-settings">
                <label className="gt-check">
                  <input type="checkbox" checked={allowGoogle}
                    onChange={(e) => setAllowGoogle(e.target.checked)} />
                  Tampilkan basemap Google
                </label>
                <p className="gt-hint">{t('basemap.googleHidden')}</p>
              </div>
            )}
          </div>
        </aside>

        <main className="gt-map-wrap">
          <MapContainer
            center={[-6.9, 107.6]}
            zoom={13}
            maxZoom={22}
            zoomControl
            preferCanvas={false}
            className="gt-map"
          >
            <ActiveBasemap basemapId={basemap} />
            <ScaleControl position="bottomleft" imperial={false} />
            <InvalidateOnResize deps={[tab]} />

            {pdf.doc && <GeoPDFLayer doc={pdf.doc} opacity={pdfOpacity} />}
            {rasterResult && (
              <RasterResultLayer result={rasterResult} opacity={0.85}
                onGeometryInfo={setRasterGeom} />
            )}
            {vector.fc && (
              <FilteredVectorLayer
                fc={vector.fc}
                mask={queryResult?.mask}
                mode={filterMode}
              />
            )}

            <GPSAccuracyLayer geo={geo} follow={follow} onFollowBreak={() => setFollow(false)} />
          </MapContainer>

          <ValidationSwitch
            disabled={!geo.safeToSample}
            warning={!geo.safeToSample && geo.status === 'active'}
            onRecord={recordSample}
            t={t}
          />
        </main>
      </div>
    </div>
  );
}

/**
 * Sakelar validasi biner.
 * Dinonaktifkan ketika akurasi GPS di luar toleransi — mencegah bias pada
 * sumbernya, bukan sekadar menandainya setelah terjadi.
 */
function ValidationSwitch({ disabled, warning, onRecord, t }) {
  const [predicted, setPredicted] = useState('');
  const [actual, setActual] = useState('');

  return (
    <div className={`gt-validation${warning ? ' is-warning' : ''}`}>
      <p className="gt-validation-q">{t('validation.question')}</p>
      <div className="gt-row">
        <input placeholder="Kelas peta" value={predicted}
          onChange={(e) => setPredicted(e.target.value)} />
        <input placeholder="Kelas lapangan (bila berbeda)" value={actual}
          onChange={(e) => setActual(e.target.value)} />
      </div>
      <div className="gt-validation-buttons">
        <button type="button" className="gt-btn-true" disabled={disabled || !predicted}
          onClick={() => onRecord(true, predicted, predicted)}>
          ✓ {t('validation.truth')}
        </button>
        <button type="button" className="gt-btn-false" disabled={disabled || !predicted}
          onClick={() => onRecord(false, predicted, actual || 'Lainnya')}>
          ✕ {t('validation.false')}
        </button>
      </div>
      {disabled && <p className="gt-hint">{t('gps.overTolerance', { acc: '—', tol: 15 })}</p>}
    </div>
  );
}

function AccuracyPanel({ metrics, binary, samples, onExport, t, nf }) {
  if (!samples.length) return <p className="gt-hint">Belum ada sampel validasi.</p>;

  return (
    <div className="gt-accuracy">
      <p><strong>{samples.length}</strong> sampel · {samples.filter((s) => s.accuracyFlagged).length} bertanda akurasi rendah</p>

      {metrics ? (
        <>
          <dl className="gt-quality">
            <div><dt>{t('accuracy.oa')}</dt>
              <dd className="mono">{nf(metrics.overallAccuracy * 100, 2)}%
                <small> [{nf(metrics.overallAccuracyCI95[0] * 100, 1)}–{nf(metrics.overallAccuracyCI95[1] * 100, 1)}]</small>
              </dd></div>
            <div><dt>{t('accuracy.kappa')}</dt><dd className="mono">{nf(metrics.kappa, 4)}</dd></div>
            <div><dt>{t('accuracy.macroF1')}</dt><dd className="mono">{nf(metrics.macroF1, 4)}</dd></div>
          </dl>

          <table className="gt-matrix">
            <thead>
              <tr><th>Kelas</th><th>UA</th><th>PA</th><th>F1</th><th>n</th></tr>
            </thead>
            <tbody>
              {metrics.perClass.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="mono">{nf(c.usersAccuracy, 3)}</td>
                  <td className="mono">{nf(c.producersAccuracy, 3)}</td>
                  <td className="mono">{nf(c.f1, 3)}</td>
                  <td className="mono">{c.mapped}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button type="button" className="gt-btn-primary" onClick={onExport}>
            Unduh matriks (CSV)
          </button>
        </>
      ) : (
        <>
          <p className="gt-hint">{binary.limitation}</p>
          <dl className="gt-quality">
            <div><dt>Tingkat kesesuaian</dt>
              <dd className="mono">{nf(binary.overallCorrectRate * 100, 1)}%</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProviders>
      <Workspace />
    </AppProviders>
  );
}
