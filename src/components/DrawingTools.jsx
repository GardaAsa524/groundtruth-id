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
import L from 'leaflet';
import { useLocale } from '../context/AppProviders.jsx';

export function DrawingTools({ onChange, defaultProperties = {} }) {
  const map = useMap();
  const { t, locale } = useLocale();
  const groupRef = useRef(null);
  const [count, setCount] = useState(0);

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
      f.properties = { ...defaultProperties, ...(f.properties ?? {}), _id: lyr._gtId };
      features.push(f);
    });
    setCount(features.length);
    onChange?.({ type: 'FeatureCollection', features });
  }, [onChange, defaultProperties]);

  useEffect(() => {
    if (!map) return undefined;
    let disposed = false;

    (async () => {
      // Muat saat dibutuhkan; Geoman ~90 kB tergzip.
      await import('@geoman-io/leaflet-geoman-free');
      await import('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css');
      if (disposed || !map.pm) return;

      const group = L.featureGroup().addTo(map);
      groupRef.current = group;

      map.pm.setLang(locale === 'id' ? 'id' : 'en');
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

      // Bersih-bersih dikembalikan lewat closure di bawah.
      groupRef.current._cleanup = () => {
        map.off('pm:create', onCreate);
        map.off('pm:remove', onRemove);
        map.off('pm:cut', emit);
        map.pm.removeControls();
        map.removeLayer(group);
      };
    })();

    return () => {
      disposed = true;
      groupRef.current?._cleanup?.();
      groupRef.current = null;
    };
  }, [map, locale, emit]);

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

  return (
    <div className="gt-draw-tools">
      <p className="gt-hint">{t('draw.hint')}</p>
      <p><strong>{count}</strong> {t('draw.featureCount')}</p>
      <button type="button" onClick={clearAll} disabled={!count}>{t('draw.clear')}</button>
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
