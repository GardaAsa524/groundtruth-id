/**
 * components/Compass.jsx
 * ---------------------------------------------------------------------------
 * Kompas perangkat.
 *
 * TIGA HAL YANG MEMBUAT KOMPAS PONSEL LEBIH RUMIT DARIPADA TAMPAKNYA
 * ------------------------------------------------------------------
 * 1. iOS 13 ke atas mewajibkan izin eksplisit lewat
 *    DeviceOrientationEvent.requestPermission(), dan panggilan itu HANYA sah
 *    bila dipicu langsung oleh ketukan pengguna. Memanggilnya di dalam
 *    useEffect selalu gagal, tanpa pesan yang menjelaskan sebabnya.
 *
 * 2. Android dan iOS melaporkan arah lewat jalur berbeda. iOS menyediakan
 *    `webkitCompassHeading` yang sudah berupa azimut sejati searah jarum jam.
 *    Android memakai `deviceorientationabsolute` dengan `alpha` yang dihitung
 *    berlawanan arah jarum jam dari utara, sehingga perlu dibalik.
 *
 * 3. Magnetometer ponsel mudah terganggu logam, kendaraan, dan casing
 *    bermagnet. Ketelitiannya lazim meleset 10-20 derajat setelah kalibrasi,
 *    dan jauh lebih buruk sebelumnya. Karena itu komponen ini menampilkan
 *    peringatan kalibrasi, dan arah yang ditunjukkannya TIDAK dipakai untuk
 *    apa pun yang mempengaruhi data — ia alat bantu orientasi, bukan alat ukur.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocale } from '../context/AppProviders.jsx';

const dirName = (deg, locale) => {
  const id = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
  const en = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const arr = locale === 'id' ? id : en;
  return arr[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};

export function Compass({ compact = false }) {
  const { t, locale, nf } = useLocale();
  const [heading, setHeading] = useState(null);
  const [status, setStatus] = useState('idle');   // idle | active | denied | unsupported
  const [needsCalibration, setNeedsCalibration] = useState(false);
  const smoothed = useRef(null);

  const handle = useCallback((e) => {
    let h = null;

    if (typeof e.webkitCompassHeading === 'number') {
      // iOS: sudah azimut sejati, searah jarum jam dari utara.
      h = e.webkitCompassHeading;
      // Akurasi -1 berarti kompas belum terkalibrasi.
      if (e.webkitCompassAccuracy != null && e.webkitCompassAccuracy < 0) {
        setNeedsCalibration(true);
      } else if (e.webkitCompassAccuracy > 20) {
        setNeedsCalibration(true);
      } else {
        setNeedsCalibration(false);
      }
    } else if (typeof e.alpha === 'number') {
      // Android: alpha berlawanan arah jarum jam, jadi dibalik.
      h = 360 - e.alpha;
      // Peristiwa non-absolut memakai acuan sembarang saat perangkat dinyalakan,
      // bukan utara magnetis — arahnya tidak berarti apa-apa.
      if (e.absolute === false) setNeedsCalibration(true);
    }

    if (h === null || Number.isNaN(h)) return;
    h = ((h % 360) + 360) % 360;

    // Perataan sudut harus melalui komponen sin/cos, bukan rata-rata derajat.
    // Merata-ratakan 359° dan 1° secara langsung menghasilkan 180°, yaitu arah
    // yang berlawanan — kesalahan klasik pada data melingkar.
    const prev = smoothed.current;
    if (prev === null) {
      smoothed.current = h;
    } else {
      const a = (prev * Math.PI) / 180;
      const b = (h * Math.PI) / 180;
      const k = 0.25;
      const x = Math.cos(a) * (1 - k) + Math.cos(b) * k;
      const y = Math.sin(a) * (1 - k) + Math.sin(b) * k;
      smoothed.current = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    setHeading(smoothed.current);
    setStatus('active');
  }, []);

  const start = useCallback(async () => {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { setStatus('unsupported'); return; }

    // iOS: izin hanya dapat diminta dari dalam penangan ketukan pengguna.
    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') { setStatus('denied'); return; }
      } catch {
        setStatus('denied');
        return;
      }
    }
    // 'deviceorientationabsolute' memberi acuan utara sejati di Android;
    // 'deviceorientation' dipakai sebagai cadangan untuk iOS.
    window.addEventListener('deviceorientationabsolute', handle, true);
    window.addEventListener('deviceorientation', handle, true);
    setStatus('active');
  }, [handle]);

  useEffect(() => () => {
    window.removeEventListener('deviceorientationabsolute', handle, true);
    window.removeEventListener('deviceorientation', handle, true);
  }, [handle]);

  if (status === 'idle') {
    return (
      <button type="button" className="gt-compass-start" onClick={start}>
        ⌖ {t('compass.enable')}
      </button>
    );
  }

  if (status === 'denied' || status === 'unsupported') {
    return <p className="gt-hint">{t(`compass.${status}`)}</p>;
  }

  const h = heading ?? 0;

  return (
    <div className={`gt-compass${compact ? ' is-compact' : ''}`}>
      <svg viewBox="0 0 100 100" className="gt-compass-dial" aria-hidden="true">
        <circle cx="50" cy="50" r="46" className="gt-cp-face" />
        {/* Piringan berputar berlawanan arah azimut, sehingga U selalu
            menunjuk utara sebenarnya sementara bagian atas layar tetap
            mewakili arah hadap pengguna. */}
        <g transform={`rotate(${-h} 50 50)`}>
          <polygon points="50,8 44,50 56,50" className="gt-cp-north" />
          <polygon points="50,92 44,50 56,50" className="gt-cp-south" />
          <text x="50" y="22" className="gt-cp-label">
            {locale === 'id' ? 'U' : 'N'}
          </text>
        </g>
        <circle cx="50" cy="50" r="4" className="gt-cp-hub" />
      </svg>
      <div className="gt-compass-read">
        <strong className="mono">{nf(h, 0)}°</strong>
        <span>{dirName(h, locale)}</span>
      </div>
      {needsCalibration && (
        <p className="gt-hint gt-cp-warn">{t('compass.calibrate')}</p>
      )}
    </div>
  );
}
