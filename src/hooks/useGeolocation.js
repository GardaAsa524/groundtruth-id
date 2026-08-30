/**
 * hooks/useGeolocation.js
 * ---------------------------------------------------------------------------
 * Jembatan dari perangkat keras GPS ke keadaan React.
 *
 * ALIRAN DATA SPASIAL DARI PERANGKAT KERAS
 * ----------------------------------------
 *   chip GNSS -> layanan lokasi sistem operasi -> Geolocation API peramban
 *   -> hook ini -> penanda Leaflet + lingkaran akurasi -> formulir sampel
 *
 * Beberapa hal yang tidak terlihat dari dokumentasi API tetapi menentukan di
 * lapangan:
 *
 * 1. `accuracy` adalah radius lingkaran kepercayaan 68% (satu sigma), bukan
 *    batas galat maksimum. Artinya sekitar sepertiga fix berada di luar
 *    lingkaran yang digambar. Ini perlu dinyatakan ke pengguna, karena banyak
 *    yang menganggapnya jaminan.
 *
 * 2. Peramban memberi fix pertama dari cache jaringan (akurasi ratusan meter)
 *    lalu menyusul fix GNSS. Merekam sampel pada fix pertama adalah sumber
 *    bias spasial yang halus dan sistematis. Kita menandai fix yang belum
 *    "matang" dan menahan tombol perekaman.
 *
 * 3. Geolocation memerlukan secure context. Pada file:// atau http:// non-
 *    localhost, permintaan gagal dengan PERMISSION_DENIED yang menyesatkan.
 *    Kita deteksi lebih dahulu dan beri pesan yang benar.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const DEFAULTS = {
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 20000,
  /** Ambang di atas mana perekaman sampel dianggap berisiko bias. */
  toleranceMeters: 15,
  /** Fix dianggap basi setelah sekian milidetik tanpa pembaruan. */
  staleAfterMs: 15000,
  /** Jumlah fix awal yang diabaikan agar penerima sempat matang. */
  warmupFixes: 2,
};

export function useGeolocation(options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const [state, setState] = useState({
    status: 'idle',        // idle | requesting | active | denied | unavailable | insecure
    position: null,        // { lat, lon, accuracy, altitude, altitudeAccuracy, heading, speed }
    error: null,
    fixCount: 0,
    stale: false,
    warmingUp: true,
  });

  const watchId = useRef(null);
  const lastFixAt = useRef(0);
  const fixCount = useRef(0);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState((s) => ({ ...s, status: 'unavailable',
        error: 'Peramban ini tidak menyediakan Geolocation API.' }));
      return;
    }
    // Deteksi konteks tidak aman lebih dahulu — pesan galat peramban untuk
    // kasus ini menyesatkan (tampak seperti izin ditolak pengguna).
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
      setState((s) => ({ ...s, status: 'insecure',
        error: 'GPS memerlukan HTTPS. Halaman ini dimuat dari konteks tidak aman.' }));
      return;
    }

    setState((s) => ({ ...s, status: 'requesting' }));
    fixCount.current = 0;

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        fixCount.current += 1;
        lastFixAt.current = Date.now();
        setState({
          status: 'active',
          error: null,
          fixCount: fixCount.current,
          stale: false,
          warmingUp: fixCount.current <= opt.warmupFixes,
          position: {
            lat: c.latitude,
            lon: c.longitude,
            accuracy: c.accuracy,
            altitude: c.altitude,
            altitudeAccuracy: c.altitudeAccuracy,
            heading: Number.isFinite(c.heading) ? c.heading : null,
            speed: Number.isFinite(c.speed) ? c.speed : null,
            timestamp: pos.timestamp,
          },
        });
      },
      (err) => {
        const map = {
          1: 'Izin lokasi ditolak. Aktifkan lewat pengaturan situs pada peramban.',
          2: 'Posisi tidak tersedia. Sinyal satelit belum diterima.',
          3: 'Waktu tunggu habis. Coba di ruang terbuka.',
        };
        setState((s) => ({
          ...s,
          status: err.code === 1 ? 'denied' : 'unavailable',
          error: map[err.code] ?? err.message,
        }));
      },
      {
        enableHighAccuracy: opt.enableHighAccuracy,
        maximumAge: opt.maximumAge,
        timeout: opt.timeout,
      }
    );
  }, [opt.enableHighAccuracy, opt.maximumAge, opt.timeout, opt.warmupFixes]);

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setState((s) => ({ ...s, status: 'idle' }));
  }, []);

  // Deteksi fix basi. Peramban tidak memberi tahu ketika sinyal hilang; ia
  // hanya berhenti memanggil callback. Tanpa pemeriksaan ini, penanda tetap
  // tampak sah padahal posisinya sudah lama tidak diperbarui.
  useEffect(() => {
    const id = setInterval(() => {
      setState((s) => {
        if (!s.position) return s;
        const isStale = Date.now() - lastFixAt.current > opt.staleAfterMs;
        return isStale === s.stale ? s : { ...s, stale: isStale };
      });
    }, 3000);
    return () => clearInterval(id);
  }, [opt.staleAfterMs]);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  const acc = state.position?.accuracy ?? null;
  const quality =
    acc === null ? 'unknown'
      : acc <= 5 ? 'excellent'
      : acc <= opt.toleranceMeters ? 'good'
      : acc <= opt.toleranceMeters * 3 ? 'poor'
      : 'unusable';

  return {
    ...state,
    start,
    stop,
    accuracy: acc,
    quality,
    /** Boleh merekam sampel? Menggabungkan seluruh syarat menjadi satu jawaban. */
    safeToSample:
      state.status === 'active' &&
      !state.stale &&
      !state.warmingUp &&
      acc !== null &&
      acc <= opt.toleranceMeters,
    toleranceMeters: opt.toleranceMeters,
  };
}
