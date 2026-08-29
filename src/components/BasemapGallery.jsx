/**
 * components/BasemapGallery.jsx
 * ---------------------------------------------------------------------------
 * Galeri peta dasar XYZ.
 *
 * CATATAN LISENSI YANG PERLU DIPUTUSKAN SEBELUM PRODUKSI
 * -----------------------------------------------------
 * Endpoint ubin Google (`mt{s}.google.com/vt`) dipakai luas di QGIS dan tutorial
 * Leaflet, tetapi berada di luar ketentuan Google Maps Platform: ToS mewajibkan
 * akses lewat Maps JavaScript API atau Map Tiles API berbayar. Untuk aplikasi
 * internal atau riset pribadi risikonya kecil; untuk produk yang dipublikasikan
 * atas nama MangGIS.co, ini adalah paparan hukum yang nyata.
 *
 * Karena itu setiap entri diberi tanda `licence` dan antarmuka menampilkannya.
 * Entri Google ditandai `requiresReview: true` sehingga keputusan diambil sadar,
 * bukan karena lupa. Esri World Imagery dan OSM/Carto bebas dipakai dengan
 * atribusi dan merupakan jalur yang aman.
 */

import React, { useEffect, useMemo } from 'react';
import { TileLayer, useMap } from 'react-leaflet';
import { useTheme, useLocale } from '../context/AppProviders.jsx';

/**
 * Definisi disimpan sebagai data murni sehingga dapat diuji, diserialkan ke
 * pengaturan pengguna, dan diperluas tanpa menyentuh komponen.
 */
export const BASEMAPS = [
  {
    id: 'osm',
    label: { id: 'OpenStreetMap Standar', en: 'OpenStreetMap Standard' },
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { subdomains: 'abc', maxNativeZoom: 19, maxZoom: 22 },
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    theme: 'light',
    licence: 'ODbL — bebas dengan atribusi',
  },
  {
    id: 'esri-light',
    label: { id: 'Esri Light Gray (terang)', en: 'Esri Light Gray' },
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    options: { maxNativeZoom: 16, maxZoom: 22 },
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap',
    theme: 'light',
    licence: 'Bebas dengan atribusi',
  },
  {
    id: 'esri-dark',
    label: { id: 'Esri Dark Gray (gelap)', en: 'Esri Dark Gray' },
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    options: { maxNativeZoom: 16, maxZoom: 22 },
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap',
    theme: 'dark',
    licence: 'Bebas dengan atribusi',
  },
  {
    id: 'carto-dark',
    label: { id: 'Carto Dark Matter', en: 'Carto Dark Matter' },
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxNativeZoom: 20, maxZoom: 22 },
    attribution: '&copy; OpenStreetMap, &copy; <a href="https://carto.com/attributions">CARTO</a>',
    theme: 'dark',
    // CARTO kini mewajibkan API key untuk endpoint ubin rasternya. Tanpa kunci,
    // ubin tetap tersaji tetapi bertuliskan "API KEY REQUIRED" di seluruh peta.
    licence: 'Perlu API key CARTO',
    requiresReview: true,
  },
  {
    id: 'esri-imagery',
    label: { id: 'Esri World Imagery', en: 'Esri World Imagery' },
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxNativeZoom: 19, maxZoom: 22 },
    attribution: 'Citra: Esri, Maxar, Earthstar Geographics',
    theme: 'dark',
    licence: 'Bebas dengan atribusi',
    imagery: true,
  },
  {
    id: 'esri-topo',
    label: { id: 'Esri World Topo', en: 'Esri World Topo' },
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    options: { maxNativeZoom: 19, maxZoom: 22 },
    attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
    theme: 'light',
    licence: 'Bebas dengan atribusi',
  },
  {
    id: 'google-streets',
    label: { id: 'Google Maps (jalan)', en: 'Google Maps (streets)' },
    url: 'https://mt{s}.google.com/vt/lyrs=m&hl={lang}&x={x}&y={y}&z={z}',
    options: { subdomains: ['0', '1', '2', '3'], maxNativeZoom: 21, maxZoom: 22 },
    attribution: 'Peta: Google',
    theme: 'light',
    licence: 'Di luar ToS Google Maps Platform',
    requiresReview: true,
  },
  {
    id: 'google-satellite',
    label: { id: 'Google Earth (satelit)', en: 'Google Earth (satellite)' },
    url: 'https://mt{s}.google.com/vt/lyrs=s&hl={lang}&x={x}&y={y}&z={z}',
    options: { subdomains: ['0', '1', '2', '3'], maxNativeZoom: 21, maxZoom: 22 },
    attribution: 'Citra: Google',
    theme: 'dark',
    licence: 'Di luar ToS Google Maps Platform',
    requiresReview: true,
    imagery: true,
  },
  {
    id: 'google-hybrid',
    label: { id: 'Google Hibrida', en: 'Google Hybrid' },
    url: 'https://mt{s}.google.com/vt/lyrs=y&hl={lang}&x={x}&y={y}&z={z}',
    options: { subdomains: ['0', '1', '2', '3'], maxNativeZoom: 21, maxZoom: 22 },
    attribution: 'Citra: Google',
    theme: 'dark',
    licence: 'Di luar ToS Google Maps Platform',
    requiresReview: true,
    imagery: true,
  },
];

export const getBasemap = (id) => BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];

/**
 * Lapisan aktif.
 *
 * Kunci `key` pada TileLayer sengaja disetel ke id basemap. Tanpa itu,
 * react-leaflet akan mencoba memperbarui URL pada instans L.TileLayer yang sama;
 * Leaflet menangani itu dengan buruk dan menyisakan ubin lama dari penyedia
 * sebelumnya selama beberapa detik. Mengganti `key` memaksa pelepasan dan
 * pemasangan ulang yang bersih.
 */
export function ActiveBasemap({ basemapId, opacity = 1 }) {
  const { locale } = useLocale();
  const bm = useMemo(() => getBasemap(basemapId), [basemapId]);
  const url = bm.url.replace('{lang}', locale === 'id' ? 'id' : 'en');

  return (
    <TileLayer
      key={bm.id}
      url={url}
      attribution={bm.attribution}
      opacity={opacity}
      {...bm.options}
    />
  );
}

/**
 * Pemilih basemap.
 * Mengikuti tema bila pengguna belum memilih sendiri (lihat followTheme).
 */
export function BasemapGallery({ value, onChange, allowGoogle = false }) {
  const { t, locale } = useLocale();
  const { isDark, suggestedBasemap, followTheme, setFollowTheme } = useTheme();

  // Sinkronisasi tema -> basemap. Hanya berjalan selama followTheme aktif;
  // begitu pengguna memilih manual, kita berhenti mengganggu pilihannya.
  useEffect(() => {
    if (followTheme && value !== suggestedBasemap) onChange(suggestedBasemap);
  }, [isDark, followTheme, suggestedBasemap]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = allowGoogle ? BASEMAPS : BASEMAPS.filter((b) => !b.requiresReview);

  return (
    <div className="gt-basemap-gallery">
      <div className="gt-panel-head">
        <h3>{t('basemap.title')}</h3>
        <label className="gt-check">
          <input
            type="checkbox"
            checked={followTheme}
            onChange={(e) => setFollowTheme(e.target.checked)}
          />
          {t('basemap.followTheme')}
        </label>
      </div>

      <div className="gt-basemap-grid">
        {list.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`gt-basemap-item${value === b.id ? ' is-active' : ''}`}
            onClick={() => { setFollowTheme(false); onChange(b.id); }}
            title={b.licence}
          >
            <span className={`gt-basemap-swatch is-${b.theme}${b.imagery ? ' is-imagery' : ''}`} />
            <span className="gt-basemap-label">{b.label[locale] ?? b.label.en}</span>
            {b.requiresReview && <span className="gt-badge-warn">{t('basemap.licenceWarn')}</span>}
          </button>
        ))}
      </div>

      {!allowGoogle && (
        <p className="gt-hint">{t('basemap.googleHidden')}</p>
      )}
    </div>
  );
}

/**
 * Menjaga agar peta memuat ulang ubin setelah panel samping membuka/menutup.
 * Leaflet menghitung ukuran kontainer sekali; perubahan tata letak CSS tidak
 * memicu perhitungan ulang dan menghasilkan ubin abu-abu di tepi.
 */
export function InvalidateOnResize({ deps = [] }) {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize({ pan: false }), 220);
    return () => clearTimeout(id);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}
