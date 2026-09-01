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

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { MapContainer, ScaleControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { AppProviders, useTheme, useLocale, useProject } from './context/AppProviders.jsx';
import { useGeolocation } from './hooks/useGeolocation.js';
import { usePanelSize } from './hooks/usePanelSize.js';
import { ActiveBasemap, BasemapGallery, InvalidateOnResize } from './components/BasemapGallery.jsx';
import { GPSAccuracyLayer, GPSReadout } from './components/GPSAccuracyLayer.jsx';
import { useGeoPDF, GeoPDFLayer, GeoPDFQualityPanel } from './components/GeoPDFLayer.jsx';
import {
  useVectorFile, AttributeQueryBuilder, FilteredVectorLayer, CRSPrompt,
  SymbologyPanel,
} from './components/AttributeQueryBuilder.jsx';
import { ExportPanel } from './components/ExportPanel.jsx';
import { AboutPanel } from './components/AboutPanel.jsx';
import {
  ConfusionMatrixChart, ClassAccuracyChart, AgreementBar,
} from './components/AccuracyCharts.jsx';
import { HeatOverlay } from './components/HeatOverlay.jsx';
import { HEAT_MODES } from './core/accuracy/heat.js';
import { useSheetSync } from './hooks/useSheetSync.js';
import { SYNC } from './core/sync/sheets.js';
import { Compass } from './components/Compass.jsx';
import {
  RulerLayer, TrackLayer, MeasureToolbar, useTrackRecorder,
} from './components/Measure.jsx';
import { LayerPanel, LegendList, MiniAttributeTable } from './components/LayerPanel.jsx';
import { legendEntries } from './core/vector/style.js';
import { AreaByClassChart } from './components/AreaChart.jsx';
import { boundsOf } from './core/vector/reproject.js';
import './styles/layer-panel.css';
import { DrawingTools, DrawingPanel, ExportButton } from './components/DrawingTools.jsx';
import {
  MapBridge, CenterTracker, CrosshairOverlay, SamplingBar, SampleSheet,
  SampleMarkers, toUTM,
} from './components/Sampling.jsx';
import {
  buildMatrix, computeMetrics, computeBinaryValidation, matrixToCSV,
} from './core/accuracy/confusionMatrix.js';

const TABS = ['map', 'layers', 'accuracy', 'export', 'settings', 'about'];

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
  const panel = usePanelSize({ open: panelOpen, onToggle: setPanelOpen });

  const [rulerActive, setRulerActive] = useState(false);
  const [rulerMode, setRulerMode] = useState('distance');
  const [rulerPoints, setRulerPoints] = useState([]);
  const [heatMode, setHeatMode] = useState('off');
  const [layerOrder, setLayerOrder] = useState([]);   // id, depan ke belakang
  const [classOff, setClassOff] = useState({});       // { layerId: { kelas: true } }
  const fileInput = useRef(null);
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
    // Kartu progres untuk berkas yang sedang dibaca. Tanpa ini, memuat berkas
    // besar tampak seperti tidak terjadi apa-apa selama beberapa detik.
    if (pdf.status === 'parsing' || pdf.status === 'rendering') {
      out.unshift({ id: 'geopdf-loading', kind: 'geopdf', status: 'loading',
        name: 'GeoPDF', progress: pdf.progress });
    }
    if (vector.status === 'loading') {
      out.unshift({ id: 'vector-loading', kind: 'vector', status: 'loading',
        name: vector.name ?? 'Vektor' });
    }

    if (layerOrder.length) {
      out.sort((a, b) => {
        const ia = layerOrder.indexOf(a.id);
        const ib = layerOrder.indexOf(b.id);
        return (ia < 0 ? -1 : ia) - (ib < 0 ? -1 : ib);
      });
    }
    return out;
  }, [pdf.doc, pdf.status, pdf.progress, vector.fc, vector.bounds, vector.crs,
      vector.name, vector.status, samples, drawnFeatures, track.points,
      layerState, layerOrder, t]);

  // Lapisan baru masuk di depan; urutan yang sudah diatur pengguna dipertahankan.
  const layerIds = layers.map((l) => l.id).join('|');
  useEffect(() => {
    setLayerOrder((prev) => {
      const ids = layerIds ? layerIds.split('|') : [];
      const kept = prev.filter((id) => ids.includes(id));
      const baru = ids.filter((id) => !kept.includes(id));
      return [...baru, ...kept];
    });
  }, [layerIds]);

  const vis = useCallback((id) => layerState[id]?.visible !== false, [layerState]);
  const opac = useCallback(
    (id, def = 1) => layerState[id]?.opacity ?? def, [layerState]);

  /** Naik-turunkan lapisan. Urutan yang dipilih pengguna selalu menang. */
  const reorder = useCallback((id, delta) => {
    setLayerOrder((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const i = next.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= next.length) return prev;
      next.splice(j, 0, next.splice(i, 1)[0]);
      return next;
    });
  }, []);

  const toggleClass = useCallback((layerId, value) => {
    setClassOff((prev) => {
      const cur = prev[layerId] ?? {};
      return { ...prev, [layerId]: { ...cur, [value]: !cur[value] } };
    });
  }, []);

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
        <aside className={`gt-sidebar${panelOpen ? '' : ' is-collapsed'}`
          + (panel.dragging ? ' is-dragging' : '')}>
          {/* Layar lebar: pegangan tipis di tepi kanan, mengatur lebar. */}
          <div className="gt-resizer" title={t('ui.resize')}
            aria-label={t('ui.resize')} {...panel.edgeProps} />

          {/*
            Ponsel: tombol ini SEKALIGUS pegangan. Ketuk untuk membuka atau
            menutup, seret ke atas dan bawah untuk mengatur tinggi. Menyatukan
            keduanya menghindari dua kendali berdesakan di tepi yang sama, dan
            memberi target sentuh selebar layar alih-alih strip 14 piksel.
          */}
          <button type="button" className="gt-panel-toggle"
            title={t('ui.gripHint')} {...panel.gripProps}>
            <span className="gt-panel-grip" />
            <span className="gt-panel-toggle-label">
              {panelOpen ? t('ui.hidePanel') : t('ui.showPanel')}
            </span>
            <span className="gt-panel-hint">{t('ui.dragHint')}</span>
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
                <Compass />

                <hr />
                <DrawingPanel featureCollection={drawnFeatures} controlsRef={drawControls} />
                <ExportButton featureCollection={drawnFeatures} />

                <hr />
                <BasemapGallery value={basemap} onChange={setBasemap} allowGoogle={allowGoogle} />
              </>
            )}

            {tab === 'layers' && (
              <>
                {/*
                  GeoPDF dan GeoJSON disatukan di sini. Sebelumnya keduanya
                  tersebar di tab berbeda, sehingga tidak ada satu tempat pun
                  untuk menjawab "bagaimana saya menambah data" — pertanyaan
                  pertama setiap pengguna baru.
                */}
                <h3 className="gt-section-h">{t('layers.add')}</h3>

                <label className="gt-addlayer">
                  <span className="gt-addlayer-icon">PDF</span>
                  <span className="gt-addlayer-text">
                    <strong>GeoPDF</strong>
                    <small>{t('layers.addPdfHint')}</small>
                  </span>
                  <input type="file" accept="application/pdf"
                    onChange={(e) => e.target.files[0] && pdf.load(e.target.files[0])} />
                </label>
                {pdf.status === 'parsing' && <p className="gt-hint">{t('layers.parsing')}</p>}
                {pdf.status === 'rendering' && <p className="gt-hint">{t('layers.rendering')}</p>}
                {pdf.status === 'error' && <p className="gt-gps-alert">{pdf.error}</p>}
                {pdf.doc && (
                  <details className="gt-details">
                    <summary>{t('layers.pdfQuality')}</summary>
                    <GeoPDFQualityPanel doc={pdf.doc} t={t} nf={nf} />
                    <label className="gt-slider">
                      {t('raster.opacity')} {Math.round(pdfOpacity * 100)}%
                      <input type="range" min="0" max="1" step="0.05" value={pdfOpacity}
                        onChange={(e) => setPdfOpacity(parseFloat(e.target.value))} />
                    </label>
                  </details>
                )}

                <label className="gt-addlayer">
                  <span className="gt-addlayer-icon is-vector">GEO</span>
                  <span className="gt-addlayer-text">
                    <strong>GeoJSON</strong>
                    <small>{t('layers.addVectorHint')}</small>
                  </span>
                  <input type="file" accept=".geojson,.json" ref={fileInput}
                    onChange={(e) => e.target.files.length && vector.load(e.target.files)} />
                </label>

                <label className="gt-addlayer">
                  <span className="gt-addlayer-icon is-kml">KML</span>
                  <span className="gt-addlayer-text">
                    <strong>KML</strong>
                    <small>{t('layers.addKmlHint')}</small>
                  </span>
                  <input type="file" accept=".kml"
                    onChange={(e) => e.target.files.length && vector.load(e.target.files)} />
                </label>
                {vector.status === 'loading' && <p className="gt-hint">{t('layers.parsing')}</p>}
                {vector.status === 'error' && <p className="gt-gps-alert">{vector.error}</p>}
                <CRSPrompt vector={vector} onPick={vector.applyCRS} />
                {vector.crs?.reprojected && (
                  <p className="gt-hint">{t('vector.reprojected', { epsg: vector.crs.epsg })}</p>
                )}

                <hr />
                <LayerPanel
                  layers={layers}
                  onChange={updateLayer}
                  onZoom={zoomTo}
                  onRemove={removeLayer}
                  onReorder={reorder}
                  onCancel={(id) => (id.startsWith('vector') ? vector.clear() : undefined)}
                  onPickFile={() => fileInput.current?.click()}
                  renderSection={(l, section) => {
                    if (l.kind === 'geopdf') {
                      return pdf.doc ? <GeoPDFQualityPanel doc={pdf.doc} t={t} nf={nf} /> : null;
                    }
                    if (l.kind !== 'vector' || !vector.fc) return null;

                    if (section === 'sym') {
                      return (
                        <>
                          <SymbologyPanel fc={vector.fc} schema={vector.schema}
                            value={symbology} onChange={setSymbology} />
                          {symbology.field && (
                            <LegendList
                              entries={legendEntries(vector.fc, symbology.field, symbology.colors)}
                              off={classOff[l.id]}
                              onToggle={(v) => toggleClass(l.id, v)}
                              nf={nf}
                            />
                          )}
                        </>
                      );
                    }
                    if (section === 'filter') {
                      return (
                        <>
                          <AttributeQueryBuilder fc={vector.fc} schema={vector.schema}
                            onResult={setQueryResult} />
                          <div className="gt-row">
                            <span className="gt-hint">{t('vector.rest')}</span>
                            <div className="gt-seg gt-seg-sm">
                              {['dim', 'hide'].map((m) => (
                                <button key={m} type="button"
                                  className={filterMode === m ? 'is-on' : ''}
                                  onClick={() => setFilterMode(m)}>
                                  {m === 'dim' ? t('vector.dim') : t('vector.hide')}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      );
                    }
                    if (section === 'area') {
                      return (
                        <AreaByClassChart fc={vector.fc} field={symbology.field}
                          colors={symbology.colors} mask={queryResult?.mask} />
                      );
                    }
                    return (
                      <MiniAttributeTable fc={vector.fc} nf={nf}
                        onRowClick={(f) => zoomTo(boundsOf({ features: [f] }))} />
                    );
                  }}
                />
              </>
            )}

            {tab === 'accuracy' && (
              <AccuracyPanel
                metrics={metrics} binary={binary} samples={samples}
                onExport={exportCSV} t={t} nf={nf}
                heatMode={heatMode} onHeatMode={setHeatMode}
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
                symbology={{ ...symbology, classOff: classOff.vector }}
              />
            )}

            {vis('samples') && <SampleMarkers samples={samples} onDelete={deleteSample} />}
            <GPSAccuracyLayer geo={geo} follow={follow} onFollowBreak={() => setFollow(false)} />

            {/* Wajib di dalam MapContainer: memanggil useMap(). */}
            <DrawingTools onChange={setDrawnFeatures} controlsRef={drawControls} />

            <HeatOverlay samples={samples} mode={heatMode} />
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

function AccuracyPanel({ metrics, binary, samples, onExport, t, nf,
                        heatMode, onHeatMode }) {
  if (!samples.length) return <p className="gt-hint">{t('accuracy.noSamples')}</p>;

  const ditandai = samples.filter((s) => s.accuracyFlagged).length;

  return (
    <div className="gt-accuracy">
      <p><strong>{samples.length}</strong> {t('export.pointsUnit')}
        {ditandai > 0 && <> · {ditandai} {t('accuracy.flagged')}</>}</p>

      <AgreementBar samples={samples} />

      {/*
        Peta panas ditempatkan di tab Akurasi, bukan tab Peta, karena ia bagian
        dari analisis hasil — bukan alat navigasi. Mode "sebaran kesalahan"
        didahulukan: itulah yang menghasilkan temuan, sedangkan kerapatan
        seluruh sampel hanya menjawab di mana kita pernah berjalan.
      */}
      <h4 className="gt-section-h" style={{ marginTop: 16 }}>{t('heat.title')}</h4>
      <div className="gt-seg gt-full-seg">
        {[
          ['off', t('heat.off')],
          [HEAT_MODES.ERRORS, t('heat.errors')],
          [HEAT_MODES.ACCURACY, t('heat.rate')],
          [HEAT_MODES.ALL, t('heat.all')],
        ].map(([k, label]) => (
          <button key={k} type="button" className={heatMode === k ? 'is-on' : ''}
            onClick={() => onHeatMode(k)}>{label}</button>
        ))}
      </div>
      <p className="gt-hint">{t(`heat.hint.${heatMode}`)}</p>

      {metrics ? (
        <>
          <dl className="gt-quality" style={{ marginTop: 16 }}>
            <div><dt>{t('accuracy.oa')}</dt>
              <dd className="mono">{nf(metrics.overallAccuracy * 100, 2)}%
                <small> [{nf(metrics.overallAccuracyCI95[0] * 100, 1)}–{nf(metrics.overallAccuracyCI95[1] * 100, 1)}]</small>
              </dd></div>
            <div><dt>{t('accuracy.kappa')}</dt><dd className="mono">{nf(metrics.kappa, 4)}</dd></div>
            <div><dt>{t('accuracy.macroF1')}</dt><dd className="mono">{nf(metrics.macroF1, 4)}</dd></div>
          </dl>

          <ClassAccuracyChart metrics={metrics} />
          <ConfusionMatrixChart cm={metrics.cm} metrics={metrics} />

          <details className="gt-details">
            <summary>{t('accuracy.table')}</summary>
            <table className="gt-matrix">
              <thead>
                <tr><th>{t('accuracy.class')}</th><th>UA</th><th>PA</th><th>F1</th><th>n</th></tr>
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
          </details>

          <button type="button" className="gt-btn-primary" onClick={onExport}>
            {t('accuracy.downloadCSV')}
          </button>
        </>
      ) : (
        <>
          <p className="gt-hint" style={{ marginTop: 14 }}>{binary.limitation}</p>
          <dl className="gt-quality">
            <div><dt>{t('accuracy.agreementRate')}</dt>
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
