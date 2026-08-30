/**
 * components/DrawingTools.jsx
 * ---------------------------------------------------------------------------
 * Digitasi in-situ dengan Leaflet-Geoman, plus ekspor GeoJSON.
 *
 * MENGAPA GEOMAN, BUKAN LEAFLET-DRAW
 * ----------------------------------
 * Leaflet.draw praktis tidak terpelihara sejak 2017 dan memiliki bug sentuh
 * yang mengganggu di peramban seluler — tepatnya lingkungan tempat aplikasi ini
 * dipakai. Geoman aktif dikembangkan, mendukung sentuh dengan baik, dan
 * menyediakan penyuntingan simpul serta snapping yang penting saat mendigitasi
 * poligon bersebelahan (batas tutupan lahan tidak boleh bercelah).
 *
 * Geoman bukan komponen React. Ia dipasang ke instans peta lewat useMap() di
 * dalam useEffect, dan seluruh listener dilepas saat pembongkaran. Menyimpan
 * FeatureGroup di ref, bukan state, karena isinya berubah pada setiap gerakan
 * vertex.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useMap } from 'react-leaflet';

// URUTAN KETIGA IMPOR DI BAWAH INI PENTING DAN TIDAK BOLEH DIUBAH.
//
// Geoman memasang dirinya ke Leaflet lewat L.Map.addInitHook, yang hanya
// berlaku untuk instans peta yang dibuat SESUDAH ia dimuat. Ketika Geoman
// dimuat lewat impor dinamis di dalam useEffect, ia selalu selesai setelah
// MapContainer membuat petanya — sehingga map.pm tidak pernah ada dan bilah
// alat gambar tidak pernah muncul, tanpa satu pun pesan galat.
//
// Impor statis menyelesaikannya: modul dievaluasi sebelum render pertama.
// leafletGlobal harus lebih dahulu karena ia yang menyediakan variabel global
// `L` yang dicari Geoman.
import L from '../core/geo/leafletGlobal.js';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

import { useLocale } from '../context/AppProviders.jsx';

/**
 * Kendali digitasi. WAJIB dirender di dalam <MapContainer>.
 *
 * Komponen ini memanggil useMap(), dan react-leaflet melempar galat bila
 * dipanggil di luar MapContainer. Galat itu tidak tertangkap oleh apa pun:
 * React membatalkan seluruh pohon dan yang tampil adalah halaman putih total,
 * bukan sekadar komponen yang hilang. Karena itu bagian antarmukanya
 * (penghitung dan tombol Kosongkan) dipisahkan ke <DrawingPanel> yang bebas
 * dari useMap dan boleh diletakkan di panel samping.
 *
 * @param {object} controlsRef ref yang akan diisi { clearAll, addFeature }
 *        supaya panel samping dapat memerintah tanpa perlu akses ke peta.
 */
/**
 * Objek kosong bersama, dideklarasikan di luar komponen.
 *
 * INI BUKAN SEKADAR KERAPIAN. Menulis `defaultProperties = {}` sebagai nilai
 * bawaan parameter menghasilkan objek BARU pada setiap render. Bila objek itu
 * masuk ke daftar dependensi, seluruh rantai useCallback dan useEffect di
 * bawahnya ikut berubah identitas tiap render — dan effect yang memuat Geoman
 * secara asinkron akan dibongkar sebelum impornya selesai, sehingga kendalinya
 * tidak pernah terpasang. Kegagalannya sepenuhnya senyap.
 */
const NO_PROPS = Object.freeze({});

export function DrawingTools({ onChange, defaultProperties = NO_PROPS, controlsRef }) {
  const map = useMap();
  const { t, locale } = useLocale();
  const groupRef = useRef(null);
  const [count, setCount] = useState(0);

  // onChange dan defaultProperties disimpan di ref, bukan dijadikan dependensi.
  // Effect pemasangan Geoman harus berjalan SEKALI per instans peta; ia tidak
  // boleh ikut terpengaruh oleh identitas prop yang berubah tiap render.
  const onChangeRef = useRef(onChange);
  const propsRef = useRef(defaultProperties);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { propsRef.current = defaultProperties; }, [defaultProperties]);

  const emit = useCallback(() => {
    const g = groupRef.current;
    if (!g) return;
    const features = [];
    g.eachLayer((lyr) => {
      if (typeof lyr.toGeoJSON !== 'function') return;
      const f = lyr.toGeoJSON();
      // Geometri lingkaran tidak ada di spesifikasi GeoJSON. Geoman
      // mengekspornya sebagai Point; kita simpan radiusnya di properti agar
      // informasinya tidak hilang, dan tandai supaya konsumen tahu.
      if (lyr instanceof L.Circle) {
        f.properties = { ...f.properties, _geom: 'circle', radius_m: lyr.getRadius() };
      }
      f.properties = { ...propsRef.current, ...(f.properties ?? {}), _id: lyr._gtId };
      features.push(f);
    });
    setCount(features.length);
    onChangeRef.current?.({ type: 'FeatureCollection', features });
  }, []);   // stabil seumur komponen — lihat catatan NO_PROPS di atas

  useEffect(() => {
    if (!map) return undefined;

    {
      if (!map.pm) {
        // Gagal senyap adalah yang membuat bug ini bertahan lama: bilah alat
        // hilang tanpa satu pun pesan. Sekarang ia berbicara.
        console.error(
          'Geoman tidak terpasang pada instans peta. Kendali gambar tidak akan muncul.'
        );
        return undefined;
      }

      const group = L.featureGroup().addTo(map);
      groupRef.current = group;

      map.pm.addControls({
        position: 'topleft',
        drawMarker: true,
        drawPolyline: true,
        drawPolygon: true,
        drawRectangle: true,
        drawCircle: true,
        drawCircleMarker: false,
        drawText: false,
        editMode: true,
        dragMode: true,
        cutPolygon: true,
        removalMode: true,
        rotateMode: false,
      });

      // Snapping ke geometri yang sudah ada: mencegah celah antarpoligon,
      // masalah yang selalu muncul saat mendigitasi batas tutupan lahan.
      map.pm.setGlobalOptions({
        snappable: true,
        snapDistance: 20,
        allowSelfIntersection: false,
        templineStyle: { color: '#ff2e88' },
        hintlineStyle: { color: '#ff2e88', dashArray: '5,5' },
        pathOptions: { color: '#ff2e88', fillColor: '#ff2e88', fillOpacity: 0.2, weight: 2 },
      });

      const onCreate = (e) => {
        e.layer._gtId = `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
        group.addLayer(e.layer);
        // Perubahan pada geometri yang sudah jadi juga harus tercatat.
        e.layer.on('pm:edit pm:dragend pm:cut', emit);
        emit();
      };
      const onRemove = (e) => { group.removeLayer(e.layer); emit(); };

      map.on('pm:create', onCreate);
      map.on('pm:remove', onRemove);
      map.on('pm:cut', emit);

      groupRef.current._cleanup = () => {
        map.off('pm:create', onCreate);
        map.off('pm:remove', onRemove);
        map.off('pm:cut', emit);
        map.pm.removeControls();
        map.removeLayer(group);
      };
    }

    return () => {
      groupRef.current?._cleanup?.();
      groupRef.current = null;
    };
    // HANYA `map`. Menambahkan `locale` atau `emit` di sini mengembalikan bug
    // pemasangan-ulang; bahasa Geoman diperbarui lewat effect terpisah di bawah.
  }, [map]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Bahasa kendali diubah tanpa membongkar seluruh pemasangan.
  useEffect(() => {
    if (map?.pm) map.pm.setLang(locale === 'id' ? 'id' : 'en');
  }, [map, locale]);

  /** Menambahkan geometri dari luar, misalnya hasil kueri atribut. */
  const addFeature = useCallback((geojson) => {
    const g = groupRef.current;
    if (!g) return;
    L.geoJSON(geojson).eachLayer((lyr) => {
      lyr._gtId = `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      g.addLayer(lyr);
    });
    emit();
  }, [emit]);

  const clearAll = useCallback(() => {
    groupRef.current?.clearLayers();
    emit();
  }, [emit]);

  // Serahkan kendali ke pemanggil supaya panel samping dapat memakainya.
  useEffect(() => {
    if (controlsRef) controlsRef.current = { clearAll, addFeature, count };
  }, [controlsRef, clearAll, addFeature, count]);

  // Tidak menggambar apa pun sendiri: seluruh antarmukanya milik Geoman,
  // yang menyisipkan kendalinya langsung ke kontainer peta.
  return null;
}

/**
 * Panel samping digitasi.
 *
 * Sengaja tidak memanggil useMap(), sehingga aman diletakkan di mana saja di
 * luar peta. Jumlah geometri dibaca dari FeatureCollection yang sudah ada di
 * status aplikasi, bukan dari instans Leaflet.
 */
export function DrawingPanel({ featureCollection, controlsRef }) {
  const { t } = useLocale();
  const n = featureCollection?.features?.length ?? 0;

  return (
    <div className="gt-draw-tools">
      <p className="gt-hint">{t('draw.hint')}</p>
      <p><strong>{n}</strong> {t('draw.featureCount')}</p>
      <button type="button" disabled={!n}
        onClick={() => controlsRef?.current?.clearAll?.()}>
        {t('draw.clear')}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- ekspor */

/**
 * Ekspor GeoJSON ke penyimpanan lokal.
 *
 * Dua hal yang membedakan implementasi ini dari `<a download>` sederhana:
 *
 * 1. Anggota CRS dihilangkan. GeoJSON RFC 7946 menetapkan CRS84 (lintang-bujur
 *    WGS 84) dan melarang anggota "crs"; menyertakannya membuat berkas ditolak
 *    beberapa alat modern. Bila data berasal dari CRS lain, ia harus
 *    ditransformasi lebih dahulu, bukan diberi label.
 *
 * 2. Web Share API dipakai lebih dahulu di iOS. Safari iOS lama mengabaikan
 *    atribut `download` sehingga berkas terbuka sebagai teks alih-alih
 *    terunduh — kegagalan senyap yang membuat pengguna mengira datanya hilang.
 */
export async function downloadGeoJSON(featureCollection, filename = 'observasi.geojson', { pretty = true } = {}) {
  const clean = {
    type: 'FeatureCollection',
    features: (featureCollection?.features ?? []).map((f) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: f.properties ?? {},
    })),
  };
  const text = JSON.stringify(clean, null, pretty ? 1 : 0);
  const blob = new Blob([text], { type: 'application/geo+json' });

  try {
    const file = new File([blob], filename, { type: 'application/geo+json' });
    if (navigator.canShare?.({ files: [file] }) && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: filename });
      return { ok: true, via: 'share' };
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, via: 'share', cancelled: true };
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  return { ok: true, via: 'anchor', bytes: blob.size };
}

/** Tombol ekspor dengan penamaan berkas bercap waktu. */
export function ExportButton({ featureCollection, prefix = 'GroundTruth' }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const n = featureCollection?.features?.length ?? 0;

  const run = async () => {
    setBusy(true);
    const d = new Date();
    const p = (v) => String(v).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    await downloadGeoJSON(featureCollection, `${prefix}_${stamp}.geojson`);
    setBusy(false);
  };

  return (
    <button type="button" className="gt-btn-primary" disabled={!n || busy} onClick={run}>
      {busy ? t('draw.exporting') : t('draw.export', { n })}
    </button>
  );
}
