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

/** Panel penggaris: mode, hasil, dan kendali. */
export function RulerPanel({ active, onToggle, points, onUndo, onClear, mode, onModeChange }) {
  const { t, locale, nf } = useLocale();
  const { total, segments } = useMemo(() => pathLength(points), [points]);
  const area = useMemo(
    () => (mode === 'area' && points.length >= 3 ? polygonArea(points) : 0),
    [points, mode]
  );
  const lastBearing = useMemo(() => {
    if (points.length < 2) return null;
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    return bearing(a.lat, a.lon, b.lat, b.lon);
  }, [points]);

  return (
    <div className="gt-ruler">
      <div className="gt-row">
        <button type="button"
          className={active ? 'gt-btn-primary' : ''}
          onClick={() => onToggle(!active)}>
          {active ? t('ruler.stop') : t('ruler.start')}
        </button>
        <div className="gt-seg">
          {['distance', 'area'].map((m) => (
            <button key={m} type="button" className={mode === m ? 'is-on' : ''}
              onClick={() => onModeChange(m)}>
              {t(`ruler.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>

      {active && <p className="gt-hint">{t('ruler.hint')}</p>}

      {points.length > 0 && (
        <>
          <dl className="gt-quality">
            <div><dt>{t('ruler.points')}</dt><dd className="mono">{points.length}</dd></div>
            <div><dt>{t('ruler.total')}</dt>
              <dd className="mono">{formatDistance(total, locale)}</dd></div>
            {segments.length > 0 && (
              <div><dt>{t('ruler.lastSegment')}</dt>
                <dd className="mono">{formatDistance(segments[segments.length - 1], locale)}</dd></div>
            )}
            {lastBearing !== null && (
              <div><dt>{t('ruler.bearing')}</dt>
                <dd className="mono">{nf(lastBearing, 1)}&deg;</dd></div>
            )}
            {area > 0 && (
              <div><dt>{t('ruler.area')}</dt>
                <dd className="mono">{formatArea(area, locale)}</dd></div>
            )}
          </dl>

          {mode === 'area' && points.length < 3 && (
            <p className="gt-hint">{t('ruler.needThree')}</p>
          )}

          <div className="gt-row">
            <button type="button" onClick={onUndo}>{t('ruler.undo')}</button>
            <button type="button" onClick={onClear}>{t('ruler.clear')}</button>
          </div>
        </>
      )}
    </div>
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

/** Panel jejak: kendali dan ringkasan. */
export function TrackPanel({ track, geo }) {
  const { t, locale, nf } = useLocale();
  const s = track.stats;

  const durasi = useMemo(() => {
    const total = Math.round(s.durationMs / 1000);
    const m = Math.floor(total / 60);
    const d = total % 60;
    return `${m}m ${String(d).padStart(2, '0')}d`;
  }, [s.durationMs]);

  const gpsOff = geo.status !== 'active';

  return (
    <div className="gt-track">
      <div className="gt-row">
        {!track.recording ? (
          <button type="button" className="gt-btn-primary"
            disabled={gpsOff} onClick={track.start}>
            ● {t('track.start')}
          </button>
        ) : (
          <button type="button" className="gt-btn-primary is-recording"
            onClick={track.stop}>
            ■ {t('track.stop')}
          </button>
        )}
        <button type="button" disabled={!track.points.length} onClick={track.clear}>
          {t('track.clear')}
        </button>
      </div>

      {gpsOff && !track.recording && <p className="gt-hint">{t('track.needGPS')}</p>}

      {track.points.length > 0 && (
        <>
          <dl className="gt-quality">
            <div><dt>{t('track.length')}</dt>
              <dd className="mono">{formatDistance(s.length, locale)}</dd></div>
            <div><dt>{t('track.duration')}</dt><dd className="mono">{durasi}</dd></div>
            <div><dt>{t('track.points')}</dt><dd className="mono">{s.points}</dd></div>
            <div><dt>{t('track.avgSpeed')}</dt>
              <dd className="mono">{nf(s.avgSpeed * 3.6, 1)} km/j</dd></div>
          </dl>

          {/*
            Fix yang ditolak ditampilkan, tidak disembunyikan. Bila jejak terasa
            lebih pendek daripada yang dijalani, angka inilah yang menjelaskan
            sebabnya — dan itu jauh lebih berguna daripada membiarkan pengguna
            menduga aplikasinya rusak.
          */}
          {(track.rejected.accuracy + track.rejected.jump) > 0 && (
            <p className="gt-hint">
              {t('track.rejected', {
                acc: track.rejected.accuracy,
                jump: track.rejected.jump,
              })}
            </p>
          )}
        </>
      )}

      <p className="gt-hint">{t('track.filterNote')}</p>
    </div>
  );
}
