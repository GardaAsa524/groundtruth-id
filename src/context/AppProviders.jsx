/**
 * context/AppProviders.jsx
 * ---------------------------------------------------------------------------
 * Keadaan global: tema, bahasa, dan data proyek.
 *
 * PEMISAHAN KONTEKS DILAKUKAN SENGAJA
 * -----------------------------------
 * Menaruh tema, bahasa, dan seluruh dataset dalam satu Context adalah kesalahan
 * kinerja yang mahal: setiap kali pengguna menggeser penggeser transparansi,
 * seluruh pohon komponen yang membaca konteks itu akan dirender ulang —
 * termasuk tabel atribut 20.000 baris.
 *
 * Karena itu ada tiga konteks terpisah dengan frekuensi perubahan berbeda:
 *   ThemeContext    — jarang berubah (klik pengguna)
 *   LocaleContext   — sangat jarang
 *   ProjectContext  — sering, tetapi hanya dibaca panel yang relevan
 *
 * Instans peta Leaflet TIDAK PERNAH masuk state React. Ia disimpan di ref.
 * Menaruh objek peta di useState memicu render ulang pada setiap perubahan
 * internal Leaflet dan merupakan sumber tersendat paling umum pada aplikasi
 * react-leaflet.
 */

import React, {
  createContext, useContext, useState, useMemo, useCallback, useEffect, useRef,
} from 'react';
import { STRINGS } from '../i18n/strings.js';

/* ------------------------------------------------------------------- tema */

const ThemeContext = createContext(null);
export const useTheme = () => {
  const c = useContext(ThemeContext);
  if (!c) throw new Error('useTheme harus dipakai di dalam <AppProviders>');
  return c;
};

const THEME_KEY = 'gt.theme';

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
    if (saved === 'dark' || saved === 'light') return saved;
    // Hormati preferensi sistem pada pemuatan pertama.
    return typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Basemap yang disarankan mengikuti tema. Pengguna tetap dapat menimpanya;
  // sinkronisasi hanya berlaku selama mereka belum memilih sendiri.
  const [followTheme, setFollowTheme] = useState(true);

  useEffect(() => {
    // Tema diterapkan lewat atribut pada <html> supaya variabel CSS berlaku
    // untuk seluruh dokumen, termasuk kontrol Leaflet yang berada di luar
    // pohon React.
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* mode privat */ }
  }, [mode]);

  const value = useMemo(() => ({
    mode,
    isDark: mode === 'dark',
    toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')),
    setMode,
    followTheme,
    setFollowTheme,
    /**
     * Basemap yang disarankan untuk tema aktif.
     * Keduanya bebas API key — Carto dipindahkan ke daftar yang perlu ditinjau
     * sejak endpoint rasternya mewajibkan kunci.
     */
    suggestedBasemap: mode === 'dark' ? 'esri-dark' : 'osm',
  }), [mode, followTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/* ----------------------------------------------------------------- bahasa */

const LocaleContext = createContext(null);
export const useLocale = () => {
  const c = useContext(LocaleContext);
  if (!c) throw new Error('useLocale harus dipakai di dalam <AppProviders>');
  return c;
};

const LOCALE_KEY = 'gt.locale';

export function LocaleProvider({ children }) {
  const [locale, setLocale] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_KEY) : null;
    if (saved) return saved;
    return typeof navigator !== 'undefined' && /^id/i.test(navigator.language) ? 'id' : 'en';
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* abaikan */ }
  }, [locale]);

  /**
   * Penerjemah dengan interpolasi sederhana: t('gps.accuracy', {m: 4.2})
   * Kunci yang hilang dikembalikan apa adanya, bukan string kosong — supaya
   * terjemahan yang terlewat terlihat saat pengembangan, bukan menghilang.
   */
  const t = useCallback((key, vars) => {
    const table = STRINGS[locale] ?? STRINGS.id;
    let s = table[key] ?? STRINGS.id[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    toggle: () => setLocale((l) => (l === 'id' ? 'en' : 'id')),
    t,
    /** Format angka mengikuti kaidah lokal: koma desimal untuk Indonesia. */
    nf: (v, digits = 2) =>
      Number.isFinite(v)
        ? new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-US', {
            minimumFractionDigits: digits, maximumFractionDigits: digits,
          }).format(v)
        : '—',
  }), [locale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/* ---------------------------------------------------------------- proyek */

const ProjectContext = createContext(null);
export const useProject = () => {
  const c = useContext(ProjectContext);
  if (!c) throw new Error('useProject harus dipakai di dalam <AppProviders>');
  return c;
};

/**
 * Menyimpan lapisan yang dimuat, sampel validasi, dan geometri hasil digitasi.
 *
 * Dataset besar (array piksel GeoTIFF, FeatureCollection) disimpan di dalam
 * `useRef` Map, bukan di state. State hanya memegang metadata ringan dan
 * penghitung versi. Dengan begitu memuat GeoTIFF 200 MB tidak menyebabkan React
 * menyalin atau membandingkan struktur sebesar itu pada setiap render.
 */
export function ProjectProvider({ children }) {
  const store = useRef(new Map());          // id -> muatan berat
  const [layers, setLayers] = useState([]); // metadata ringan saja
  const [samples, setSamples] = useState([]);
  const [drawnFeatures, setDrawnFeatures] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);

  const addLayer = useCallback((meta, payload) => {
    const id = meta.id ?? `l${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    if (payload !== undefined) store.current.set(id, payload);
    setLayers((prev) => [...prev, { ...meta, id, visible: true, opacity: 1 }]);
    setActiveLayerId(id);
    return id;
  }, []);

  const removeLayer = useCallback((id) => {
    const payload = store.current.get(id);
    // Pembebasan eksplisit: GPU tidak akan mengumpulkan tekstur hanya karena
    // referensi JS-nya hilang.
    payload?.renderer?.dispose?.();
    payload?.objectUrls?.forEach((u) => URL.revokeObjectURL(u));
    store.current.delete(id);
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setActiveLayerId((cur) => (cur === id ? null : cur));
  }, []);

  const updateLayer = useCallback((id, patch) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const getPayload = useCallback((id) => store.current.get(id), []);

  useEffect(() => () => {
    // Pembersihan saat aplikasi dibongkar
    for (const p of store.current.values()) {
      p?.renderer?.dispose?.();
      p?.objectUrls?.forEach((u) => URL.revokeObjectURL(u));
    }
    store.current.clear();
  }, []);

  const value = useMemo(() => ({
    layers, addLayer, removeLayer, updateLayer, getPayload,
    activeLayerId, setActiveLayerId,
    samples, setSamples,
    drawnFeatures, setDrawnFeatures,
  }), [layers, addLayer, removeLayer, updateLayer, getPayload,
      activeLayerId, samples, drawnFeatures]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function AppProviders({ children }) {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <ProjectProvider>{children}</ProjectProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
