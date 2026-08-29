/**
 * components/Sampling.jsx
 * ---------------------------------------------------------------------------
 * Perekaman titik validasi: bidik silang, formulir kelas, dan penanda hasil.
 *
 * MENGAPA RANCANGANNYA BERUBAH
 * ----------------------------
 * Versi sebelumnya menampilkan formulir validasi sebagai panel tetap di atas
 * peta. Cacatnya mendasar: panel itu menutup sepertiga layar sepanjang waktu,
 * padahal hanya dipakai beberapa detik setiap kali merekam titik. Di lapangan,
 * yang paling dibutuhkan justru peta yang lapang.
 *
 * Pola yang dipakai sekarang sama dengan aplikasi survei pohon: peta penuh,
 * bidik silang tetap di tengah, satu tombol perekam, dan formulir yang hanya
 * muncul setelah titik ditempatkan.
 *
 * DUA SUMBER KOORDINAT, DAN MENGAPA KEDUANYA PERLU
 * ------------------------------------------------
 *   GPS       — posisi perangkat. Tepat bila langit terbuka.
 *   Crosshair — titik tengah layar. Tepat bila Anda dapat mengenali objeknya
 *               pada citra.
 *
 * Perbedaan penting dalam penerapannya: mode GPS **dikunci** ketika akurasi
 * melampaui toleransi, karena titiknya memang tidak dapat dipercaya. Mode
 * crosshair **tidak pernah dikunci**, karena koordinatnya berasal dari citra,
 * bukan dari penerima GNSS. Justru ketika sinyal buruk di bawah tajuk rapat,
 * mode crosshair adalah jawabannya — bukan alasan untuk berhenti bekerja.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useMap, useMapEvents, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useLocale } from '../context/AppProviders.jsx';
import { forwardUTM, utmZoneFromLon } from '../core/geo/projection.js';

/* ------------------------------------------------------------ jembatan peta */

/**
 * Menyimpan instans peta ke dalam ref milik pemanggil.
 * Wajib dirender di dalam <MapContainer> karena memakai useMap().
 */
export function MapBridge({ mapRef }) {
  const map = useMap();
  useEffect(() => {
    if (mapRef) mapRef.current = map;
    return () => { if (mapRef) mapRef.current = null; };
  }, [map, mapRef]);
  return null;
}

/**
 * Melaporkan titik tengah peta saat digeser.
 *
 * Pembaruan dibatasi satu kali per bingkai gambar. Peristiwa 'move' Leaflet
 * dapat menyala puluhan kali per detik saat peta digeser; memanggil setState
 * pada tiap peristiwa membuat peta tersendat di ponsel kelas menengah.
 */
export function CenterTracker({ onCenter }) {
  const pending = useRef(false);

  const report = useCallback((map) => {
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      const c = map.getCenter();
      onCenter({ lat: c.lat, lon: c.lng });
    });
  }, [onCenter]);

  const map = useMapEvents({
    move: () => report(map),
    zoomend: () => report(map),
  });

  useEffect(() => { report(map); }, [map, report]);
  return null;
}

/* ------------------------------------------------------------ bidik silang */

/**
 * Bidik silang tetap di tengah layar.
 *
 * Digambar sebagai lapisan DOM biasa di atas peta, bukan sebagai penanda
 * Leaflet. Alasannya: penanda Leaflet terikat pada koordinat dan ikut bergerak
 * saat peta digeser, sedangkan bidik silang justru harus diam di tengah layar.
 *
 * pointer-events dimatikan supaya seluruh gerakan sentuh tetap sampai ke peta.
 */
export function CrosshairOverlay({ active, center, utm }) {
  const { t, nf } = useLocale();
  if (!active) return null;

  return (
    <div className="gt-crosshair" aria-hidden="true">
      <svg viewBox="0 0 80 80" className="gt-crosshair-mark">
        <circle cx="40" cy="40" r="26" className="gt-ch-ring" />
        <line x1="40" y1="2" x2="40" y2="24" className="gt-ch-arm" />
        <line x1="40" y1="56" x2="40" y2="78" className="gt-ch-arm" />
        <line x1="2" y1="40" x2="24" y2="40" className="gt-ch-arm" />
        <line x1="56" y1="40" x2="78" y2="40" className="gt-ch-arm" />
        <circle cx="40" cy="40" r="3.5" className="gt-ch-dot" />
      </svg>
      {center && (
        <div className="gt-crosshair-readout mono">
          {center.lat.toFixed(6)}, {center.lon.toFixed(6)}
          {utm && <span> · {nf(utm.x, 0)} {nf(utm.y, 0)} {utm.label}</span>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ bilah perekam titik */

/**
 * Bilah bawah: pemilih mode dan tombol perekam.
 * Ringkas dan menempel di tepi bawah, tidak menutupi bagian tengah peta.
 */
export function SamplingBar({ mode, onModeChange, onCapture, geo, disabledReason }) {
  const { t, nf } = useLocale();

  const gpsBlocked =
    mode === 'gps' &&
    (geo.status !== 'active' || !geo.safeToSample);

  const blockedNote = !gpsBlocked ? null
    : geo.status !== 'active' ? t('sampling.gpsOff')
    : geo.warmingUp ? t('gps.warmingUp')
    : geo.stale ? t('gps.stale')
    : t('sampling.gpsTooRough', { acc: nf(geo.accuracy, 1), tol: geo.toleranceMeters });

  return (
    <div className="gt-sampling-bar">
      <div className="gt-seg gt-mode-seg">
        <button type="button" className={mode === 'gps' ? 'is-on' : ''}
          onClick={() => onModeChange('gps')}>
          {t('sampling.modeGPS')}
        </button>
        <button type="button" className={mode === 'crosshair' ? 'is-on' : ''}
          onClick={() => onModeChange('crosshair')}>
          {t('sampling.modeCrosshair')}
        </button>
      </div>

      <button
        type="button"
        className="gt-capture"
        disabled={gpsBlocked || !!disabledReason}
        onClick={() => onCapture(mode)}
      >
        + {mode === 'gps' ? t('sampling.captureGPS') : t('sampling.captureCrosshair')}
      </button>

      {blockedNote && (
        <p className="gt-sampling-note">
          {blockedNote}
          {mode === 'gps' && (
            <button type="button" className="gt-linkish"
              onClick={() => onModeChange('crosshair')}>
              {t('sampling.switchToCrosshair')}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- formulir */

/**
 * Lembar isian yang muncul setelah titik ditempatkan.
 *
 * Kelas peta memakai datalist, bukan dropdown tertutup: daftar kelas tumbuh
 * sendiri dari yang pernah diketik, sehingga ejaan konsisten tanpa memaksa
 * pengguna mendefinisikan skema di muka.
 */
export function SampleSheet({ draft, knownClasses, onSave, onCancel }) {
  const { t, nf } = useLocale();
  const [predicted, setPredicted] = useState('');
  const [verdict, setVerdict] = useState(null);      // true = sesuai
  const [actual, setActual] = useState('');
  const [note, setNote] = useState('');
  const firstField = useRef(null);

  // Setel ulang tiap kali titik baru dibuka, dan pertahankan kelas terakhir —
  // pada satu blok survei, kelas peta biasanya sama berturut-turut.
  useEffect(() => {
    if (!draft) return;
    setVerdict(null);
    setActual('');
    setNote('');
    setPredicted(draft.lastPredicted ?? '');
    setTimeout(() => firstField.current?.focus(), 50);
  }, [draft]);

  if (!draft) return null;

  const needsActual = verdict === false;
  const canSave = predicted.trim() !== '' && verdict !== null &&
    (!needsActual || actual.trim() !== '');

  const submit = () => {
    if (!canSave) return;
    onSave({
      lat: draft.lat,
      lon: draft.lon,
      source: draft.source,
      accuracy: draft.accuracy ?? null,
      predicted: predicted.trim(),
      isCorrect: verdict,
      // Bila sesuai, kelas rujukan sama dengan kelas peta. Bila tidak sesuai,
      // kelas rujukan wajib diisi — tanpanya matriks konfusi tidak dapat
      // dibangun dan hanya User's Accuracy yang bisa dihitung.
      actual: verdict ? predicted.trim() : actual.trim(),
      note: note.trim(),
    });
  };

  return (
    <div className="gt-sheet-backdrop" onClick={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}>
      <div className="gt-sheet" role="dialog" aria-modal="true">
        <div className="gt-sheet-grip" />

        <div className="gt-sheet-head">
          <h3>{t('sampling.newPoint')}</h3>
          <span className={`gt-source-tag is-${draft.source}`}>
            {draft.source === 'gps'
              ? `GPS ±${nf(draft.accuracy, 1)} m`
              : t('sampling.modeCrosshair')}
          </span>
        </div>

        <p className="gt-sheet-coord mono">
          {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
          {draft.utm && <><br />{nf(draft.utm.x, 2)} · {nf(draft.utm.y, 2)} · {draft.utm.label}</>}
        </p>

        <label className="gt-field">
          {t('sampling.mapClass')}
          <input ref={firstField} list="gt-known-classes" value={predicted}
            placeholder={t('sampling.mapClassHint')}
            onChange={(e) => setPredicted(e.target.value)} />
          <datalist id="gt-known-classes">
            {knownClasses.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>

        <p className="gt-sheet-q">{t('validation.question')}</p>
        <div className="gt-validation-buttons">
          <button type="button"
            className={`gt-btn-true${verdict === true ? ' is-on' : ''}`}
            disabled={!predicted.trim()}
            onClick={() => setVerdict(true)}>
            ✓ {t('validation.truth')}
          </button>
          <button type="button"
            className={`gt-btn-false${verdict === false ? ' is-on' : ''}`}
            disabled={!predicted.trim()}
            onClick={() => setVerdict(false)}>
            ✕ {t('validation.false')}
          </button>
        </div>

        {needsActual && (
          <label className="gt-field">
            {t('sampling.fieldClass')}
            <input list="gt-known-classes" value={actual} autoFocus
              placeholder={t('sampling.fieldClassHint')}
              onChange={(e) => setActual(e.target.value)} />
          </label>
        )}

        <label className="gt-field">
          {t('sampling.note')}
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="gt-sheet-actions">
          <button type="button" onClick={onCancel}>{t('sampling.cancel')}</button>
          <button type="button" className="gt-btn-primary" disabled={!canSave} onClick={submit}>
            {t('sampling.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ penanda hasil */

const sampleIcon = (isCorrect, source) => L.divIcon({
  className: '',
  html: `<div class="gt-sample-pin ${isCorrect ? 'is-true' : 'is-false'} src-${source}">
           ${isCorrect ? '✓' : '✕'}
         </div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** Menggambar seluruh titik yang sudah direkam. Wajib di dalam MapContainer. */
export function SampleMarkers({ samples, onDelete }) {
  const { t, nf } = useLocale();
  return (
    <>
      {samples.map((s) => (
        <Marker key={s.id} position={[s.lat, s.lon]}
          icon={sampleIcon(s.isCorrect, s.source ?? 'gps')}>
          <Popup>
            <strong>{s.predicted}</strong><br />
            {s.isCorrect ? t('validation.truth') : `${t('validation.false')} → ${s.actual}`}<br />
            <span className="mono">
              {s.source === 'gps' ? `GPS ±${nf(s.accuracy, 1)} m` : t('sampling.modeCrosshair')}
            </span>
            {s.note && <><br /><em>{s.note}</em></>}
            <br />
            <button type="button" onClick={() => onDelete(s.id)}>{t('sampling.delete')}</button>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/** Koordinat UTM dari lintang-bujur, untuk ditampilkan berdampingan. */
export function toUTM(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const zone = utmZoneFromLon(lon);
  const r = forwardUTM(lat, lon, { zone, south: lat < 0 });
  return { ...r, label: `UTM ${zone}${lat < 0 ? 'S' : 'N'}` };
}
