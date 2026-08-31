/**
 * components/Measure.jsx
 * ---------------------------------------------------------------------------
 * Penggaris (ruler) dan perekam jejak (track).
 *
 * Keduanya disatukan di sini karena berbagi lapisan penyajian yang sama:
 * garis di peta, label jarak, dan ringkasan angka. Yang berbeda hanya asal
 * titiknya — penggaris dari ketukan pengguna, jejak dari aliran fix GPS.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useMapEvents, Polyline, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import { useLocale } from '../context/AppProviders.jsx';
import {
  pathLength, polygonArea, formatDistance, formatArea, bearing,
} from '../core/geo/measure.js';
import { shouldAccept, trackStats } from '../core/track/track.js';

/* ============================================================== PENGGARIS */

/**
 * Lapisan penggaris. Wajib dirender di dalam <MapContainer>.
 *
 * Ketukan menambah simpul; ketukan pada simpul terakhir menutup pengukuran.
 * Ketika tiga simpul atau lebih ada dan mode luas aktif, bangun tertutup dan
 * luasnya ikut dihitung.
 */
export function RulerLayer({ active, points, onAddPoint, mode }) {
  const { locale } = useLocale();

  useMapEvents({
    click(e) {
      if (!active) return;
      onAddPoint({ lat: e.latlng.lat, lon: e.latlng.lng });
    },
  });

  const latlngs = useMemo(() => points.map((p) => [p.lat, p.lon]), [points]);
  const { segments } = useMemo(() => pathLength(points), [points]);

  if (!points.length) return null;
  const isArea = mode === 'area' && points.length >= 3;

  return (
    <>
      {isArea ? (
        <Polygon positions={latlngs} pathOptions={{
          color: '#ff2e88', weight: 3, fillColor: '#ff2e88', fillOpacity: 0.15,
        }} interactive={false} />
      ) : (
        latlngs.length >= 2 && (
          <Polyline positions={latlngs} pathOptions={{
            color: '#ff2e88', weight: 3, dashArray: '6,5',
          }} interactive={false} />
        )
      )}

      {points.map((p, i) => (
        <CircleMarker key={i} center={[p.lat, p.lon]} radius={5}
          pathOptions={{ color: '#fff', weight: 2, fillColor: '#ff2e88', fillOpacity: 1 }}
          interactive={false}>
          {/* Label jarak kumulatif ditempel pada simpul, bukan pada ruas:
              di layar ponsel, label di tengah ruas sering tertimpa garis. */}
          {i > 0 && (
            <Tooltip permanent direction="top" offset={[0, -6]} className="gt-ruler-tip">
              {formatDistance(segments.slice(0, i).reduce((a, b) => a + b, 0), locale)}
            </Tooltip>
          )}
        </CircleMarker>
      ))}
    </>
  );
}

/* ================================================================== JEJAK */

/**
 * Perekam jejak.
 *
 * Menerima fix dari hook geolokasi yang sudah ada, bukan membuka pengamat
 * kedua. Dua pengamat berjalan bersamaan menguras baterai dua kali lipat
 * tanpa memberi fix yang lebih baik — sistem operasi tetap memberi keduanya
 * data dari penerima yang sama.
 */
export function useTrackRecorder(geo) {
  const [recording, setRecording] = useState(false);
  const [points, setPoints] = useState([]);
  const [rejected, setRejected] = useState({ accuracy: 0, stationary: 0, jump: 0 });
  const lastRef = useRef(null);

  useEffect(() => {
    if (!recording) return;
    const p = geo.position;
    if (!p) return;

    const fix = {
      lat: p.lat, lon: p.lon, accuracy: p.accuracy,
      t: p.timestamp ?? Date.now(),
    };
    const verdict = shouldAccept(fix, lastRef.current);

    if (verdict.accept) {
      lastRef.current = fix;
      setPoints((prev) => [...prev, fix]);
    } else if (verdict.reason in rejected) {
      // Alasan penolakan dihitung dan ditampilkan. Bila jejak terasa terlalu
      // pendek, angka inilah yang menjelaskan sebabnya — bukan tebakan.
      setRejected((r) => ({ ...r, [verdict.reason]: r[verdict.reason] + 1 }));
    }
  }, [geo.position, recording]);   // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(() => {
    lastRef.current = null;
    setPoints([]);
    setRejected({ accuracy: 0, stationary: 0, jump: 0 });
    setRecording(true);
  }, []);

  const stop = useCallback(() => setRecording(false), []);
  const clear = useCallback(() => {
    setRecording(false);
    setPoints([]);
    lastRef.current = null;
  }, []);

  const stats = useMemo(() => trackStats(points), [points]);

  return { recording, points, stats, rejected, start, stop, clear };
}

/** Garis jejak di peta. Wajib di dalam <MapContainer>. */
export function TrackLayer({ points, recording }) {
  if (!points?.length) return null;
  const latlngs = points.map((p) => [p.lat, p.lon]);

  return (
    <>
      {latlngs.length >= 2 && (
        <Polyline positions={latlngs} pathOptions={{
          color: recording ? '#2bd9f0' : '#5bd08a',
          weight: 4, opacity: 0.85,
        }} interactive={false} />
      )}
      <CircleMarker center={latlngs[0]} radius={5}
        pathOptions={{ color: '#fff', weight: 2, fillColor: '#5bd08a', fillOpacity: 1 }}
        interactive={false} />
      {latlngs.length >= 2 && (
        <CircleMarker center={latlngs[latlngs.length - 1]} radius={5}
          pathOptions={{ color: '#fff', weight: 2, fillColor: '#ff2e88', fillOpacity: 1 }}
          interactive={false} />
      )}
    </>
  );
}

/* ============================================================ BILAH ALAT */

/**
 * Ikon digambar sebagai SVG sebaris, bukan berkas terpisah maupun font ikon.
 *
 * Alasannya praktis: bilah alat ini muncul di atas ortofoto yang terang maupun
 * peta gelap, jadi warnanya harus mengikuti tema lewat currentColor. Font ikon
 * dan PNG tidak bisa melakukan itu, dan berkas SVG terpisah menambah satu
 * permintaan jaringan untuk sesuatu yang berukuran 300 bita.
 */
const IconRuler = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
       stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true">
    {/* Badan penggaris dan garis skalanya berada dalam SATU grup yang diputar.
        Bila hanya badannya yang diputar, garis skala melayang lepas dari
        penggarisnya. Ukurannya juga ditahan agar sudutnya tidak terpotong
        keluar dari viewBox setelah rotasi. */}
    <g transform="rotate(-20 12 12)">
      <rect x="3" y="8.5" width="18" height="7" rx="1.2" />
      <path d="M6.5 8.5v3M10 8.5v4.2M13.5 8.5v3M17 8.5v4.2" />
    </g>
  </svg>
);

const IconTrack = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
       stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true">
    {/* Jalur berkelok dengan penanda awal dan akhir — bentuk yang sama dengan
        cara jejak digambar di peta, sehingga ikon dan hasilnya sejalan. */}
    <path d="M6.5 18.5c4.5 0 3-6 6-6s1.5-6 5-6" strokeDasharray="0" />
    <circle cx="6.5" cy="18.5" r="2.3" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="6.5" r="2.3" fill="currentColor" stroke="none" />
  </svg>
);

const IconUndo = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round"
       strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </svg>
);

const IconClose = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
       aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/**
 * Bilah alat melayang di atas peta, sejajar gaya kendali Leaflet.
 *
 * Sengaja TIDAK memanggil useMap, sehingga boleh dirender di pembungkus peta
 * di luar <MapContainer>. Hasil pengukuran ditampilkan sebagai kartu ringkas
 * yang hanya muncul saat alatnya aktif — bukan panel tetap yang memakan ruang
 * sepanjang waktu.
 */
export function MeasureToolbar({ ruler, track, geo }) {
  const { t, locale, nf } = useLocale();

  const { total, segments } = useMemo(
    () => pathLength(ruler.points), [ruler.points]);
  const area = useMemo(
    () => (ruler.mode === 'area' && ruler.points.length >= 3
      ? polygonArea(ruler.points) : 0),
    [ruler.points, ruler.mode]);

  const durasi = useMemo(() => {
    const d = Math.round(track.stats.durationMs / 1000);
    return `${Math.floor(d / 60)}m ${String(d % 60).padStart(2, '0')}d`;
  }, [track.stats.durationMs]);

  return (
    <div className="gt-maptools">
      <div className="gt-maptools-bar">
        <button type="button"
          className={`gt-maptool${ruler.active ? ' is-on' : ''}`}
          title={t('ruler.title')} aria-label={t('ruler.title')}
          aria-pressed={ruler.active}
          onClick={() => ruler.onToggle(!ruler.active)}>
          <IconRuler />
        </button>

        <button type="button"
          className={`gt-maptool${track.recording ? ' is-rec' : ''}`}
          title={t('track.title')} aria-label={t('track.title')}
          aria-pressed={track.recording}
          disabled={geo.status !== 'active' && !track.recording}
          onClick={() => (track.recording ? track.stop() : track.start())}>
          <IconTrack />
        </button>
      </div>

      {ruler.active && (
        <div className="gt-tool-card">
          <div className="gt-tool-card-head">
            <div className="gt-seg gt-seg-sm">
              {['distance', 'area'].map((m) => (
                <button key={m} type="button"
                  className={ruler.mode === m ? 'is-on' : ''}
                  onClick={() => ruler.onModeChange(m)}>
                  {t(`ruler.mode.${m}`)}
                </button>
              ))}
            </div>
            <button type="button" className="gt-tool-x"
              aria-label={t('ruler.stop')}
              onClick={() => { ruler.onClear(); ruler.onToggle(false); }}>
              <IconClose />
            </button>
          </div>

          {ruler.points.length === 0 ? (
            <p className="gt-tool-hint">{t('ruler.hint')}</p>
          ) : (
            <>
              <div className="gt-tool-figure mono">
                {ruler.mode === 'area' && area > 0
                  ? formatArea(area, locale)
                  : formatDistance(total, locale)}
              </div>
              <div className="gt-tool-meta mono">
                {ruler.points.length} {t('ruler.points').toLowerCase()}
                {segments.length > 0 && (
                  <> · {t('ruler.lastSegment').toLowerCase()}{' '}
                    {formatDistance(segments[segments.length - 1], locale)}</>
                )}
                {ruler.mode === 'area' && area > 0 && (
                  <> · {formatDistance(total, locale)}</>
                )}
              </div>
              {ruler.mode === 'area' && ruler.points.length < 3 && (
                <p className="gt-tool-hint">{t('ruler.needThree')}</p>
              )}
              <div className="gt-tool-actions">
                <button type="button" onClick={ruler.onUndo}>
                  <IconUndo /> {t('ruler.undo')}
                </button>
                <button type="button" onClick={ruler.onClear}>{t('ruler.clear')}</button>
              </div>
            </>
          )}
        </div>
      )}

      {(track.recording || track.points.length > 0) && (
        <div className={`gt-tool-card${track.recording ? ' is-rec' : ''}`}>
          <div className="gt-tool-card-head">
            <span className="gt-tool-title">
              {track.recording && <span className="gt-rec-dot" />}
              {t('track.title')}
            </span>
            {!track.recording && (
              <button type="button" className="gt-tool-x"
                aria-label={t('track.clear')} onClick={track.clear}>
                <IconClose />
              </button>
            )}
          </div>

          <div className="gt-tool-figure mono">
            {formatDistance(track.stats.length, locale)}
          </div>
          <div className="gt-tool-meta mono">
            {durasi} · {track.stats.points} {t('track.points').toLowerCase()}
            {track.stats.avgSpeed > 0 && <> · {nf(track.stats.avgSpeed * 3.6, 1)} km/j</>}
          </div>

          {/*
            Fix yang ditolak tetap ditampilkan. Bila jejak terasa lebih pendek
            daripada yang dijalani, angka inilah yang menjelaskan sebabnya.
          */}
          {(track.rejected.accuracy + track.rejected.jump) > 0 && (
            <p className="gt-tool-hint">
              {t('track.rejected', {
                acc: track.rejected.accuracy, jump: track.rejected.jump,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
