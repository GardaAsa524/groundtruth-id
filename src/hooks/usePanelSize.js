/**
 * hooks/usePanelSize.js
 * ---------------------------------------------------------------------------
 * Ukuran panel samping yang dapat diseret pengguna.
 *
 * DUA SUMBU, SATU HOOK
 * --------------------
 * Pada layar lebar panel berada di kiri dan yang diatur adalah LEBARNYA; pada
 * ponsel panel berada di bawah dan yang diatur adalah TINGGINYA. Keduanya
 * ditangani satu hook karena logika seretnya identik — hanya sumbu dan arahnya
 * yang berbeda.
 *
 * TIGA HAL YANG MEMBUAT SERET TERASA BENAR
 * ----------------------------------------
 * 1. Pointer Events, bukan mouse dan touch terpisah. Satu jalur kode untuk
 *    tetikus, sentuh, dan pena — dan setPointerCapture membuat seretan tetap
 *    terkunci walau kursor keluar dari pegangan.
 * 2. Ukuran ditulis ke variabel CSS, bukan ke gaya sebaris tiap elemen.
 *    Tata letak menyesuaikan sendiri lewat CSS, sehingga React tidak perlu
 *    dirender ulang pada setiap gerakan jari — dan seretnya tetap mulus.
 * 3. Batas minimum dan maksimum ditegakkan. Tanpa itu, panel dapat diseret
 *    sampai nol dan pegangannya ikut hilang, sehingga tidak ada cara
 *    mengembalikannya tanpa memuat ulang halaman.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const KEY = 'reis.panelSize';

/** Ambang lebar yang sama dengan titik henti di tokens.css. */
const MOBILE_MAX = 820;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function usePanelSize() {
  const [vertical, setVertical] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth <= MOBILE_MAX : false));
  const [size, setSize] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      return { w: raw.w ?? 380, h: raw.h ?? 45 };
    } catch {
      return { w: 380, h: 45 };
    }
  });
  const [dragging, setDragging] = useState(false);
  const startRef = useRef(null);

  // Pantau perubahan orientasi dan ukuran jendela.
  useEffect(() => {
    const onResize = () => setVertical(window.innerWidth <= MOBILE_MAX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Tulis ke variabel CSS; tata letak menyesuaikan sendiri tanpa render ulang.
  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty('--gt-panel-w', `${size.w}px`);
    el.style.setProperty('--gt-panel-h', `${size.h}dvh`);
    try { localStorage.setItem(KEY, JSON.stringify(size)); } catch { /* mode privat */ }
  }, [size]);

  const onPointerDown = useCallback((e) => {
    // Hanya tombol utama; klik kanan tidak boleh memulai seretan.
    if (e.button !== undefined && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startRef.current = {
      x: e.clientX, y: e.clientY,
      w: size.w, h: size.h,
      vh: window.innerHeight,
    };
    setDragging(true);
  }, [size]);

  const onPointerMove = useCallback((e) => {
    const st = startRef.current;
    if (!st) return;
    e.preventDefault();

    if (vertical) {
      // Panel di bawah: menyeret ke ATAS memperbesar, jadi selisihnya dibalik.
      const delta = ((st.y - e.clientY) / st.vh) * 100;
      setSize((s) => ({ ...s, h: clamp(st.h + delta, 18, 88) }));
    } else {
      const lebarMaks = Math.min(720, window.innerWidth - 280);
      setSize((s) => ({ ...s, w: clamp(st.w + (e.clientX - st.x), 260, lebarMaks) }));
    }
  }, [vertical]);

  const onPointerUp = useCallback((e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    startRef.current = null;
    setDragging(false);
  }, []);

  /** Kembalikan ke ukuran bawaan; dipanggil dari ketukan ganda pada pegangan. */
  const reset = useCallback(() => setSize({ w: 380, h: 45 }), []);

  /**
   * Papan ketik: panah mengubah ukuran, Home mengembalikan.
   * Pegangan seret tanpa dukungan papan ketik tidak dapat dipakai sama sekali
   * oleh pengguna yang tidak memakai tetikus.
   */
  const onKeyDown = useCallback((e) => {
    const step = e.shiftKey ? 40 : 12;
    const stepPct = e.shiftKey ? 8 : 3;
    if (vertical) {
      if (e.key === 'ArrowUp') setSize((s) => ({ ...s, h: clamp(s.h + stepPct, 18, 88) }));
      else if (e.key === 'ArrowDown') setSize((s) => ({ ...s, h: clamp(s.h - stepPct, 18, 88) }));
      else if (e.key === 'Home') reset();
      else return;
    } else {
      const maks = Math.min(720, window.innerWidth - 280);
      if (e.key === 'ArrowRight') setSize((s) => ({ ...s, w: clamp(s.w + step, 260, maks) }));
      else if (e.key === 'ArrowLeft') setSize((s) => ({ ...s, w: clamp(s.w - step, 260, maks) }));
      else if (e.key === 'Home') reset();
      else return;
    }
    e.preventDefault();
  }, [vertical, reset]);

  return {
    size, vertical, dragging, reset,
    handleProps: {
      onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: reset,
      onKeyDown,
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': vertical ? 'horizontal' : 'vertical',
      'aria-valuenow': vertical ? Math.round(size.h) : size.w,
    },
  };
}
