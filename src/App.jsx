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
 *     └ GeoJSON ─→ detectVectorCRS ─→ reprojectToWGS84 ─→ inferSchema
 *                        │                                      │
 *                        │                                      ├→ SymbologyPanel (warna kelas)
 *                        │                                      └→ AttributeQueryBuilder → bitmask
 *                        └→ CRSPrompt bila EPSG tidak diketahui      └→ FilteredVectorLayer
 *   Digitasi
 *     └ Geoman ─→ FeatureCollection ─→ ExportPanel
 *
 *   Ekspor
 *     └ sampel + foto ─→ KMZ (ZIP + doc.kml) · GeoJSON · XLSX (ZIP + OOXML)
 *
 *   Validasi
 *     └ sakelar Truth/False + kelas ─→ sampel ─→ confusionMatrix ─→ OA/F1/Kappa
 *
 * Titik penting: satu-satunya keadaan yang dibagikan lintas modul adalah
 * ProjectContext. Modul tidak saling mengimpor; mereka bertemu di sini.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { MapContainer, ScaleControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { AppProviders, useTheme, useLocale, useProject } from './context/AppProviders.jsx';
import { useGeolocation } from './hooks/useGeolocation.js';
import { ActiveBasemap, BasemapGallery, InvalidateOnResize } from './components/BasemapGallery.jsx';
import { GPSAccuracyLayer, GPSReadout } from './components/GPSAccuracyLayer.jsx';
import { useGeoPDF, GeoPDFLayer, GeoPDFQualityPanel } from './components/GeoPDFLayer.jsx';
import {
  useVectorFile, AttributeQueryBuilder, FilteredVectorLayer, CRSPrompt,
  SymbologyPanel,
} from './components/AttributeQueryBuilder.jsx';
import { ExportPanel } from './components/ExportPanel.jsx';
import { AboutPanel } from './components/AboutPanel.jsx';
import { useSheetSync } from './hooks/useSheetSync.js';
import { SYNC } from './core/sync/sheets.js';
import { Compass } from './components/Compass.jsx';
import {
  RulerLayer, TrackLayer, MeasureToolbar, useTrackRecorder,
} from './components/Measure.jsx';
import { LayerPanel } from './components/LayerPanel.jsx';
import { boundsOf } from './core/vector/reproject.js';
import { DrawingTools, DrawingPanel, ExportButton } from './components/DrawingTools.jsx';
import {
  MapBridge, CenterTracker, CrosshairOverlay, SamplingBar, SampleSheet,
  SampleMarkers, toUTM,
} from './components/Sampling.jsx';
import {
  buildMatrix, computeMetrics, computeBinaryValidation, matrixToCSV,
} from './core/accuracy/confusionMatrix.js';

const TABS = ['map', 'layers', 'query', 'accuracy', 'export', 'settings', 'about'];

function Workspace() {
  const { t, nf, toggle: toggleLocale } = useLocale();
  const { isDark, toggle: toggleTheme, suggestedBasemap } = useTheme();
  const { samples, setSamples, drawnFeatures, setDrawnFeatures } = useProject();

  const [tab, setTab] = useState('map');
  const [basemap, setBasemap] = useState(suggestedBasemap);
  const [allowGoogle, setAllowGoogle] = useState(false);
  const [follow, setFollow] = useState(true);
  const [pdfOpacity, setPdfOpacity] = useState(1);
  const [queryResult, setQueryResult] = useState(null);
  const [filterMode, setFilterMode] = useState('dim');

  // Jembatan dari panel samping ke kendali digitasi yang hidup di dalam peta.
  const drawControls = useRef(null);
  const mapRef = useRef(null);

  const [sampleMode, setSampleMode] = useState('crosshair');
  // Visibilitas dan transparansi per lapisan, dikelola satu tempat.
  const [layerState, setLayerState] = useState({});
  const [symbology, setSymbology] = useState({ field: '', colors: {} });
  // Panel samping dapat disembunyikan supaya peta memakai seluruh layar —
  // pada ponsel, dashboard yang selalu terbuka menyisakan peta terlalu sempit.
  const [panelOpen, setPanelOpen] = useState(true);
  const [testing, setTesting] = useState(false);

  const [rulerActive, setRulerActive] = useState(false);
  const [rulerMode, setRulerMode] = useState('distance');
  const [rulerPoints, setRulerPoints] = useState([]);
  const [center, setCenter] = useState(null);
  const [draft, setDraft] = useState(null);      // titik menunggu diisi kelasnya

  const geo = useGeolocation({ toleranceMeters: 15 });

  // Perekam jejak menumpang aliran fix dari hook di atas, bukan membuka
  // pengamat kedua: dua watchPosition berjalan bersamaan menguras baterai dua
  // kali lipat tanpa memberi fix yang lebih baik.
  const track = useTrackRecorder(geo);

  // Tandai foto sudah terkirim supaya tidak diunggah ulang pada percobaan
  // berikutnya — inilah yang menjaga kuota data surveyor.
  const sync = useSheetSync({
    onSent: (ids) => setSamples((prev) => prev.map(
      (s) => (ids.includes(s.id) ? { ...s, photosSent: true, synced: true } : s))),
  });
  const pdf = useGeoPDF();
  const vector = useVectorFile();

  // Koordinat UTM dari fix GPS — ditampilkan berdampingan dengan lat/lon karena
  // sebagian besar data lapangan di Indonesia dikelola dalam UTM.
  const utm = useMemo(
    () => (geo.position ? toUTM(geo.position.lat, geo.position.lon) : null),
    [geo.position]
  );
  const centerUTM = useMemo(
    () => (center ? toUTM(center.lat, center.lon) : null),
    [center]
  );

  // Kelas yang pernah dipakai, untuk saran ketik pada formulir.
  const knownClasses = useMemo(() => {
    const set = new Set();
    for (const s of samples) {
      if (s.predicted) set.add(s.predicted);
      if (s.actual) set.add(s.actual);
    }
    return [...set].sort();
  }, [samples]);

  /* ---------------------------------------------------- perekaman sampel */

  /**
   * Menempatkan titik, lalu membuka formulir. Koordinatnya dibekukan di sini
   * supaya peta boleh digeser sementara formulir terbuka tanpa memindahkan
   * titik yang sudah ditempatkan.
   */
  const capture = useCallback((mode) => {
    if (mode === 'gps') {
      const p = geo.position;
      if (!p) return;
      setDraft({
        lat: p.lat, lon: p.lon, source: 'gps', accuracy: p.accuracy,
        utm: toUTM(p.lat, p.lon),
        lastPredicted: samples[samples.length - 1]?.predicted,
      });
      return;
    }
    const c = center ?? (mapRef.current ? mapRef.current.getCenter() : null);
    if (!c) return;
    const lat = c.lat, lon = c.lon ?? c.lng;
    setDraft({
      lat, lon, source: 'crosshair', accuracy: null,
      utm: toUTM(lat, lon),
      lastPredicted: samples[samples.length - 1]?.predicted,
    });
  }, [geo.position, center, samples]);

  const saveSample = useCallback((data) => {
    const row = {
      id: `s${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      ...data,
      // Jejak mutu ikut disimpan: pertanyaan pertama reviewer adalah seberapa
      // teliti posisi sampelnya, dan jawabannya berbeda untuk tiap sumber.
      accuracyFlagged: data.source === 'gps' && data.accuracy > geo.toleranceMeters,
      timestamp: new Date().toISOString(),
    };
    setSamples((prev) => [...prev, row]);
    sync.push(row);
    setDraft(null);
  }, [setSamples, geo.toleranceMeters, sync]);

  const deleteSample = useCallback((id) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
  }, [setSamples]);

  /* ------------------------------------------------------- daftar lapisan */

  /**
   * Menyatukan seluruh lapisan dari sumber yang berbeda ke satu daftar.
   * Dihitung ulang hanya bila salah satu sumbernya berubah, bukan tiap render.
   */
  const layers = useMemo(() => {
    const st = (id, def = {}) => ({ visible: true, opacity: 1, ...def, ...(layerState[id] ?? {}) });
    const out = [];

    if (pdf.doc) {
      out.push({
        id: 'geopdf', kind: 'geopdf',
        name: pdf.doc.meta?.name ?? 'GeoPDF',
        bounds: pdf.doc.bounds,
        note: pdf.doc.viewport.crs.kind === 'utm'
          ? `UTM ${pdf.doc.viewport.crs.zone}${pdf.doc.viewport.crs.south ? 'S' : 'N'}`
          : undefined,
        ...st('geopdf'),
      });
    }
    if (vector.fc) {
      out.push({
        id: 'vector', kind: 'vector',
        name: vector.name ?? 'Vektor',
        bounds: vector.bounds,
        count: vector.fc.features.length,
        note: vector.crs?.reprojected
          ? t('vector.reprojected', { epsg: vector.crs.epsg })
          : undefined,
        ...st('vector'),
      });
    }
    if (samples.length) {
      out.push({
        id: 'samples', kind: 'samples',
        name: t('nav.accuracy'),
        count: samples.length,
        bounds: boundsOf({
          features: samples.map((x) => ({
            geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
          })),
        }),
        removable: false,
        ...st('samples'),
      });
    }
    if (track.points.length) {
      out.push({
        id: 'track', kind: 'track',
        name: t('track.title'),
        count: track.points.length,
        bounds: boundsOf({
          features: [{ geometry: {
            type: 'LineString',
            coordinates: track.points.map((p) => [p.lon, p.lat]),
          } }],
        }),
        removable: false,
        ...st('track'),
      });
    }
    if (drawnFeatures?.features?.length) {
      out.push({
        id: 'drawing', kind: 'drawing',
        name: t('nav.map'),
        count: drawnFeatures.features.length,
        bounds: boundsOf(drawnFeatures),
        removable: false,
        ...st('drawing'),
      });
    }
    return out;
  }, [pdf.doc, vector.fc, vector.bounds, vector.crs, vector.name,
      samples, drawnFeatures, track.points, layerState, t]);

  const vis = useCallback((id) => layerState[id]?.visible !== false, [layerState]);
  const opac = useCallback(
    (id, def = 1) => layerState[id]?.opacity ?? def, [layerState]);

  const updateLayer = useCallback((id, patch) => {
    setLayerState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }, []);

  /** Zoom peta ke kotak pembatas lapisan. */
  const zoomTo = useCallback((bounds) => {
    if (!bounds || !mapRef.current) return;
    mapRef.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 21 });
  }, []);

  const removeLayer = useCallback((id) => {
    if (id === 'vector') vector.clear();
    if (id === 'geopdf') window.location.reload();   // GeoPDF terikat ke berkas terunggah
    setLayerState((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }, [vector]);

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
        <aside className={`gt-sidebar${panelOpen ? '' : ' is-collapsed'}`}>
          <button type="button" className="gt-panel-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}>
            <span className="gt-panel-grip" />
            {panelOpen ? t('ui.hidePanel') : t('ui.showPanel')}
          </button>
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
                <Compass />

                <hr />
                <DrawingPanel featureCollection={drawnFeatures} controlsRef={drawControls} />
                <ExportButton featureCollection={drawnFeatures} />

                <hr />
                <BasemapGallery value={basemap} onChange={setBasemap} allowGoogle={allowGoogle} />
              </>
            )}

            {tab === 'layers' && (
              <LayerPanel
                layers={layers}
                onChange={updateLayer}
                onZoom={zoomTo}
                onRemove={removeLayer}
              />
            )}

            {tab === 'query' && (
              <>
                <label className="gt-field">
                  GeoJSON / Shapefile
                  <input type="file" multiple accept=".geojson,.json,.zip,.shp,.dbf,.prj,.cpg"
                    onChange={(e) => e.target.files.length && vector.load(e.target.files)} />
                </label>
                {vector.status === 'error' && <p className="gt-gps-alert">{vector.error}</p>}

                <CRSPrompt vector={vector} onPick={vector.applyCRS} />

                {vector.fc && (
                  <>
                    <div className="gt-row">
                      <button type="button" onClick={() => zoomTo(vector.bounds)}>
                        ⤢ {t('layers.zoomTo')}
                      </button>
                      <div className="gt-seg">
                        {['dim', 'hide'].map((m) => (
                          <button key={m} type="button" className={filterMode === m ? 'is-on' : ''}
                            onClick={() => setFilterMode(m)}>
                            {m === 'dim' ? 'Redupkan' : 'Sembunyikan'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {vector.crs?.reprojected && (
                      <p className="gt-hint">
                        {t('vector.reprojected', { epsg: vector.crs.epsg })}
                      </p>
                    )}
                  </>
                )}

                {vector.fc && (
                  <SymbologyPanel fc={vector.fc} schema={vector.schema}
                    value={symbology} onChange={setSymbology} />
                )}
                <AttributeQueryBuilder fc={vector.fc} schema={vector.schema} onResult={setQueryResult} />
              </>
            )}

            {tab === 'accuracy' && (
              <AccuracyPanel
                metrics={metrics} binary={binary} samples={samples}
                onExport={exportCSV} t={t} nf={nf}
              />
            )}

            {tab === 'export' && (
              <ExportPanel
                samples={samples}
                drawnFeatures={drawnFeatures}
                cm={metrics?.cm}
                metrics={metrics}
                binary={binary}
                track={track.points.length ? { name: t('track.title'), points: track.points } : null}
                syncToken={sync.config.token}
                onSyncTokenChange={(token) => sync.update({ token })}
              />
            )}

            {tab === 'settings' && (
              <div className="gt-settings">
                <section className="gt-export-group">
                  <h4>{t('sync.title')}</h4>
                  <p className={`gt-sync-status is-${sync.status}`}>
                    {sync.status === SYNC.QUEUED
                      ? t('sync.status.queued', { n: sync.pending })
                      : t(`sync.status.${sync.status}`)}
                  </p>

                  <label className="gt-check">
                    <input type="checkbox" checked={sync.config.enabled}
                      onChange={(e) => sync.update({ enabled: e.target.checked })} />
                    {t('sync.enable')}
                  </label>

                  <label className="gt-field">
                    {t('sync.url')}
                    <input type="url" value={sync.config.url} spellCheck={false}
                      placeholder="https://script.google.com/macros/s/…/exec"
                      onChange={(e) => sync.update({ url: e.target.value.trim() })} />
                  </label>

                  <label className="gt-field">
                    {t('sync.token')}
                    <input type="password" value={sync.config.token} spellCheck={false}
                      onChange={(e) => sync.update({ token: e.target.value.trim() })} />
                  </label>

                  <label className="gt-check">
                    <input type="checkbox" checked={sync.config.sendPhotos}
                      onChange={(e) => sync.update({ sendPhotos: e.target.checked })} />
                    {t('sync.sendPhotos')}
                  </label>
                  <p className="gt-hint">{t('sync.photoWarn')}</p>

                  <div className="gt-row">
                    <button type="button" onClick={async () => {
                      setTesting(true);
                      await sync.test();
                      setTesting(false);
                    }} disabled={!sync.config.url || testing}>
                      {testing ? t('sync.testing') : t('sync.test')}
                    </button>
                    <button type="button" onClick={sync.flush}
                      disabled={!sync.pending || sync.status === SYNC.SENDING}>
                      {t('sync.flush')}
                    </button>
                  </div>

                  {sync.lastError && <p className="gt-gps-alert">{sync.lastError}</p>}
                  {sync.lastOk && !sync.lastError && (
                    <p className="gt-export-ok">
                      {t('sync.ok', { t: new Date(sync.lastOk).toLocaleTimeString() })}
                    </p>
                  )}
                  <p className="gt-hint">{t('sync.setupHint')}</p>
                </section>

                <label className="gt-check">
                  <input type="checkbox" checked={allowGoogle}
                    onChange={(e) => setAllowGoogle(e.target.checked)} />
                  Tampilkan basemap Google
                </label>
                <p className="gt-hint">{t('basemap.googleHidden')}</p>
              </div>
            )}

            {tab === 'about' && <AboutPanel />}

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
            <MapBridge mapRef={mapRef} />
            <CenterTracker onCenter={setCenter} />

            {pdf.doc && vis('geopdf') && (
              <GeoPDFLayer doc={pdf.doc} opacity={opac('geopdf', pdfOpacity)} />
            )}
            {vector.fc && vis('vector') && (
              <FilteredVectorLayer
                fc={vector.fc}
                mask={queryResult?.mask}
                mode={filterMode}
                symbology={symbology}
              />
            )}

            {vis('samples') && <SampleMarkers samples={samples} onDelete={deleteSample} />}
            <GPSAccuracyLayer geo={geo} follow={follow} onFollowBreak={() => setFollow(false)} />

            {/* Wajib di dalam MapContainer: memanggil useMap(). */}
            <DrawingTools onChange={setDrawnFeatures} controlsRef={drawControls} />

            <TrackLayer points={track.points} recording={track.recording} />
            <RulerLayer
              active={rulerActive}
              points={rulerPoints}
              mode={rulerMode}
              onAddPoint={(p) => setRulerPoints((prev) => [...prev, p])}
            />
          </MapContainer>

          <MeasureToolbar
            geo={geo}
            track={track}
            ruler={{
              active: rulerActive,
              points: rulerPoints,
              mode: rulerMode,
              onToggle: setRulerActive,
              onModeChange: setRulerMode,
              onUndo: () => setRulerPoints((p) => p.slice(0, -1)),
              onClear: () => setRulerPoints([]),
            }}
          />

          <CrosshairOverlay
            active={sampleMode === 'crosshair' && !draft && !rulerActive}
            center={center}
            utm={centerUTM}
          />

          <SamplingBar
            mode={sampleMode}
            onModeChange={setSampleMode}
            onCapture={capture}
            geo={geo}
          />

          <SampleSheet
            draft={draft}
            knownClasses={knownClasses}
            onSave={saveSample}
            onCancel={() => setDraft(null)}
          />
        </main>
      </div>
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
