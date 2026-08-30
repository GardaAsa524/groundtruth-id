/**
 * components/GPSAccuracyLayer.jsx
 * ---------------------------------------------------------------------------
 * Perwujudan visual posisi dan ketelitiannya.
 *
 * Dua elemen, dua maksud berbeda:
 *   - Penanda: perkiraan titik posisi.
 *   - Lingkaran: radius kepercayaan 68%. Bukan batas galat. Sekitar sepertiga
 *     fix jatuh di luarnya, dan itu perlu dikomunikasikan lewat teks, bukan
 *     hanya lewat gambar, karena gambar cenderung dibaca sebagai jaminan.
 *
 * Lingkaran memakai L.Circle (radius dalam meter, ikut berskala saat zoom),
 * bukan L.CircleMarker (radius piksel, tetap besar saat diperkecil). Kekeliruan
 * itu membuat akurasi 4 m tampak seperti 400 m pada zoom rendah.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import { Circle, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useLocale, useTheme } from '../context/AppProviders.jsx';

const COLOR = {
  excellent: '#22c55e',
  good: '#2bd9f0',
  poor: '#f5a524',
  unusable: '#ff4d4f',
  unknown: '#8a8a8a',
};

function positionIcon(quality, stale) {
  const c = COLOR[quality] ?? COLOR.unknown;
  return L.divIcon({
    className: '',
    html: `<div class="gt-gps-dot${stale ? ' is-stale' : ''}"
                style="--gt-gps-color:${c}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export function GPSAccuracyLayer({ geo, follow, onFollowBreak }) {
  const map = useMap();
  const firstFix = useRef(true);

  const pos = geo.position;
  const latlng = useMemo(
    () => (pos ? [pos.lat, pos.lon] : null),
    [pos?.lat, pos?.lon] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Ikuti posisi. Sekali pengguna menggeser peta, mode ikuti dimatikan —
  // memaksa peta kembali ke titik pengguna saat mereka sedang memeriksa objek
  // lain adalah salah satu gangguan paling menjengkelkan di aplikasi lapangan.
  useEffect(() => {
    if (!map) return;
    const onDrag = () => onFollowBreak?.();
    map.on('dragstart', onDrag);
    return () => map.off('dragstart', onDrag);
  }, [map, onFollowBreak]);

  useEffect(() => {
    if (!latlng || !map) return;
    if (firstFix.current) {
      map.setView(latlng, Math.max(map.getZoom(), 18));
      firstFix.current = false;
    } else if (follow) {
      map.panTo(latlng, { animate: true, duration: 0.4 });
    }
  }, [latlng, follow, map]);

  if (!latlng) return null;

  return (
    <>
      <Circle
        center={latlng}
        radius={pos.accuracy ?? 0}
        pathOptions={{
          color: COLOR[geo.quality],
          weight: 1,
          opacity: geo.stale ? 0.3 : 0.7,
          fillColor: COLOR[geo.quality],
          fillOpacity: geo.stale ? 0.05 : 0.12,
        }}
        interactive={false}
      />
      <Marker
        position={latlng}
        icon={positionIcon(geo.quality, geo.stale)}
        interactive={false}
        zIndexOffset={1000}
      />
    </>
  );
}

/**
 * Panel bacaan tekstual.
 * Ditempatkan di luar peta agar tetap terbaca di bawah sinar matahari langsung
 * (kontras tinggi, latar solid), bukan sebagai overlay tembus pandang.
 */
export function GPSReadout({ geo, utm }) {
  const { t, nf } = useLocale();
  const { isDark } = useTheme();
  const pos = geo.position;

  const overTolerance = geo.accuracy !== null && geo.accuracy > geo.toleranceMeters;

  return (
    <div className={`gt-gps-readout${overTolerance ? ' is-warning' : ''}`} data-theme={isDark ? 'dark' : 'light'}>
      <div className="gt-gps-row">
        <span className={`gt-gps-pip is-${geo.quality}`} aria-hidden="true" />
        <span className="gt-gps-status">
          {geo.status === 'active'
            ? geo.stale ? t('gps.stale') : t('gps.active')
            : t(`gps.status.${geo.status}`)}
        </span>
      </div>

      {pos && (
        <dl className="gt-gps-grid">
          <div><dt>{t('gps.lat')}</dt><dd className="mono">{pos.lat.toFixed(6)}</dd></div>
          <div><dt>{t('gps.lon')}</dt><dd className="mono">{pos.lon.toFixed(6)}</dd></div>
          {utm && (
            <>
              <div><dt>X ({utm.label})</dt><dd className="mono">{nf(utm.x, 2)}</dd></div>
              <div><dt>Y ({utm.label})</dt><dd className="mono">{nf(utm.y, 2)}</dd></div>
            </>
          )}
          <div>
            <dt>{t('gps.accuracy')}</dt>
            <dd className="mono">±{nf(pos.accuracy, 1)} m</dd>
          </div>
          {Number.isFinite(pos.altitude) && (
            <div>
              <dt>{t('gps.altitude')}</dt>
              <dd className="mono">{nf(pos.altitude, 1)} m</dd>
            </div>
          )}
        </dl>
      )}

      {geo.warmingUp && geo.status === 'active' && (
        <p className="gt-gps-note">{t('gps.warmingUp')}</p>
      )}

      {overTolerance && (
        <p className="gt-gps-alert" role="alert">
          {t('gps.overTolerance', {
            acc: nf(geo.accuracy, 1),
            tol: geo.toleranceMeters,
          })}
        </p>
      )}

      {geo.error && <p className="gt-gps-alert" role="alert">{geo.error}</p>}

      <p className="gt-gps-fineprint">{t('gps.sigmaNote')}</p>
    </div>
  );
}
