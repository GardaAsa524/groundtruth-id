/**
 * hooks/usePanelSize.js
 * ---------------------------------------------------------------------------
 * Ukuran panel samping yang dapat diseret pengguna.
 *
 * DUA SUMBU, DUA PEGANGAN, SATU HOOK
 * ----------------------------------
 * Pada layar lebar panel berada di kiri dan yang diatur adalah LEBARNYA lewat
 * pegangan tipis di tepi kanan — pola baku yang sudah dikenal orang dari
 * aplikasi desktop.
 *
 * Pada ponsel panel berada di bawah dan yang diatur adalah TINGGINYA. Di sana
 * pegangan tipis tidak dapat dipakai: jari menutupi target setebal 14 piksel,
 * dan meletakkannya berdampingan dengan tombol "Sembunyikan panel" membuat dua
 * kendali berdesakan di tempat yang sama. Karena itu di ponsel **tombolnya
 * sendiri yang menjadi pegangan**: ketuk untuk menutup, seret untuk mengatur
 * tinggi.
 *
 * MEMBEDAKAN KETUKAN DARI SERETAN
 * -------------------------------
 * Satu elemen yang menangani keduanya harus memutuskan mana yang dimaksud.
 * Ambangnya jarak, bukan waktu: seretan pelan sejauh 40 piksel jelas seretan
 * walau lambat, sedangkan ketukan yang bergeser 2 piksel karena jari bergetar
 * tetap ketukan. Ambang 8 piksel kira-kira setara ketidakstabilan jari pada
 * layar sentuh.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const KEY = 'reis.panelSize';

/** Sama dengan titik henti di tokens.css. */
const MOBILE_MAX = 820;

/** Jarak minimum sebelum gerakan dianggap seretan, bukan ketukan. */
const DRAG_THRESHOLD = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function usePanelSize({ open = true, onToggle } = {}) {
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
  const movedRef = useRef(false);

  useEffect(() => {
    const onResize = () => setVertical(window.innerWidth <= MOBILE_MAX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Ukuran ditulis ke variabel CSS, bukan gaya sebaris tiap elemen: tata letak
  // menyesuaikan sendiri lewat CSS sehingga React tidak dirender ulang pada
  // setiap gerakan jari, dan seretnya tetap mulus.
  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty('--gt-panel-w', `${size.w}px`);
    el.style.setProperty('--gt-panel-h', `${size.h}dvh`);
    try { localStorage.setItem(KEY, JSON.stringify(size)); } catch { /* mode privat */ }
  }, [size]);

  const maxWidth = () =>
    Math.min(720, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 280);

  const reset = useCallback(() => setSize({ w: 380, h: 45 }), []);

  /* ------------------------------------------------ inti seret, dua sumbu */

  const begin = useCallback((e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startRef.current = {
      x: e.clientX, y: e.clientY,
      w: size.w, h: size.h,
      vh: typeof window !== 'undefined' ? window.innerHeight : 800,
      wasOpen: open,
    };
    movedRef.current = false;
  }, [size, open]);

  const move = useCallback((e, axis) => {
    const st = startRef.current;
    if (!st) return;

    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    const jarak = Math.hypot(dx, dy);

    if (!movedRef.current) {
      if (jarak < DRAG_THRESHOLD) return;   // masih mungkin ketukan
      movedRef.current = true;
      setDragging(true);
      // Menyeret panel yang sedang tertutup membukanya lebih dahulu; kalau
      // tidak, pengguna menyeret sesuatu yang tidak terlihat berubah.
      if (!st.wasOpen) onToggle?.(true);
    }

    e.preventDefault();
    if (axis === 'y') {
      // Menyeret ke ATAS memperbesar panel, jadi selisihnya dibalik.
      setSize((s) => ({ ...s, h: clamp(st.h + ((st.y - e.clientY) / st.vh) * 100, 18, 88) }));
    } else {
      setSize((s) => ({ ...s, w: clamp(st.w + dx, 260, maxWidth()) }));
    }
  }, [onToggle]);

  const end = useCallback((e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const adalahKetukan = startRef.current && !movedRef.current;
    startRef.current = null;
    setDragging(false);
    return adalahKetukan;
  }, []);

  /* --------------------------------------------- papan ketik untuk keduanya */

  const keyHandler = useCallback((axis) => (e) => {
    if (axis === 'y') {
      const step = e.shiftKey ? 8 : 3;
      if (e.key === 'ArrowUp') setSize((s) => ({ ...s, h: clamp(s.h + step, 18, 88) }));
      else if (e.key === 'ArrowDown') setSize((s) => ({ ...s, h: clamp(s.h - step, 18, 88) }));
      else if (e.key === 'Home') reset();
      else if (e.key === 'Enter' || e.key === ' ') { onToggle?.(!open); e.preventDefault(); return; }
      else return;
    } else {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === 'ArrowRight') setSize((s) => ({ ...s, w: clamp(s.w + step, 260, maxWidth()) }));
      else if (e.key === 'ArrowLeft') setSize((s) => ({ ...s, w: clamp(s.w - step, 260, maxWidth()) }));
      else if (e.key === 'Home') reset();
      else return;
    }
    e.preventDefault();
  }, [reset, onToggle, open]);

  return {
    size, vertical, dragging, reset,

    /** Pegangan tipis di tepi kanan panel. Hanya dipakai pada layar lebar. */
    edgeProps: {
      onPointerDown: begin,
      onPointerMove: (e) => move(e, 'x'),
      onPointerUp: end,
      onPointerCancel: end,
      onDoubleClick: reset,
      onKeyDown: keyHandler('x'),
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': Math.round(size.w),
    },

    /**
     * Tombol "Sembunyikan panel" pada ponsel, yang sekaligus menjadi pegangan.
     * Ketukan diteruskan ke onToggle; seretan mengatur tinggi.
     */
    gripProps: {
      onPointerDown: begin,
      onPointerMove: (e) => move(e, 'y'),
      onPointerUp: (e) => { if (end(e)) onToggle?.(!open); },
      onPointerCancel: end,
      onKeyDown: keyHandler('y'),
      // Tanpa ini, peramban menggulirkan halaman alih-alih menyerahkan
      // gerakan vertikal ke penangan kita.
      style: { touchAction: 'none' },
      'aria-expanded': open,
      'aria-valuenow': Math.round(size.h),
    },
  };
}
