/**
 * components/TabBar.jsx
 * ---------------------------------------------------------------------------
 * Bilah tab bawah berikon.
 *
 * MENGAPA IKON, DAN MENGAPA TETAP DENGAN LABEL
 * --------------------------------------------
 * Ikon saja lebih ringkas, tetapi hampir selalu ambigu pada aplikasi yang
 * jarang dipakai: "lapisan" dan "ekspor" tidak punya lambang yang dikenali
 * semua orang tanpa diajari. Label kecil di bawah ikon menghapus tebakan itu
 * dengan biaya beberapa piksel. Aplikasi lapangan dipakai sambil berdiri,
 * kadang oleh surveyor yang baru memakainya minggu itu — bukan tempat untuk
 * teka-teki lambang.
 *
 * GULIR MENDATAR, BUKAN MEMAKSA MUAT
 * ----------------------------------
 * Enam tab tidak muat di layar sempit tanpa memampatkan tiap tab menjadi
 * terlalu kecil untuk dikenai jari. Memaksa muat berarti target sentuh
 * menyusut di bawah ambang yang wajar. Karena itu bilahnya digulir: tiap tab
 * mempertahankan lebar minimum, dan yang tidak muat dapat digeser.
 *
 * Petunjuk gulir berupa gradien pudar di tepi kanan; tanpa itu, tab yang
 * tersembunyi tidak akan pernah ditemukan orang.
 */

import React, { useRef, useEffect } from 'react';
import { useLocale } from '../context/AppProviders.jsx';

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round',
};

/* Ikon digambar sebagai SVG sebaris memakai currentColor, sehingga warnanya
   mengikuti keadaan aktif dan tema tanpa berkas atau kelas tambahan. */
const ICONS = {
  map: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M9 4.5 3 7v12.5l6-2.5 6 2.5 6-2.5V4.5l-6 2.5-6-2.5Z" />
      <path d="M9 4.5V17M15 7v12.5" />
    </svg>
  ),
  layers: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 3 3 7.6l9 4.6 9-4.6L12 3Z" />
      <path d="M3 12.2l9 4.6 9-4.6" />
      <path d="M3 16.6l9 4.6 9-4.6" />
    </svg>
  ),
  accuracy: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2" />
    </svg>
  ),
  export: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 15.5V3.5" />
      <path d="M7.8 7.7 12 3.5l4.2 4.2" />
      <path d="M4 15v3.6c0 1 .8 1.9 1.9 1.9h12.2c1 0 1.9-.8 1.9-1.9V15" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.11a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 0 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1.5Z" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 16.4v-5" />
      <circle cx="12" cy="8.1" r=".9" fill="currentColor" stroke="none" />
    </svg>
  ),
};

/**
 * @param {Array<{key:string, label:string, badge?:number}>} tabs
 * @param {string} active
 * @param {(key:string)=>void} onSelect  dipanggil untuk tab mana pun, termasuk
 *        tab yang sedang aktif — pemanggil yang memutuskan apakah itu berarti
 *        menutup panel.
 */
export function TabBar({ tabs, active, onSelect, open = true }) {
  const { t } = useLocale();
  const barRef = useRef(null);
  const activeRef = useRef(null);

  // Tab aktif digulirkan ke dalam pandangan. Tanpa ini, memilih tab terakhir
  // lalu memuat ulang halaman meninggalkan tab aktif di luar layar, dan
  // pengguna tidak tahu sedang berada di mana.
  useEffect(() => {
    const el = activeRef.current;
    if (!el || !barRef.current) return;
    // scrollIntoView tidak ada di sebagian WebView lama. Menggulir otomatis
    // adalah kenyamanan, bukan syarat — jadi ketiadaannya dilewati begitu saja
    // alih-alih menjatuhkan seluruh bilah tab.
    el.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [active]);

  return (
    <nav className="gt-tabbar" ref={barRef} role="tablist"
      aria-label={t('ui.sections')}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={isActive ? activeRef : null}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-expanded={isActive ? open : undefined}
            className={`gt-tab${isActive ? ' is-on' : ''}`}
            onClick={() => onSelect(tab.key)}
          >
            <span className="gt-tab-icon">
              {ICONS[tab.key] ?? ICONS.about}
              {tab.badge > 0 && (
                <span className="gt-tab-badge">
                  {tab.badge > 99 ? '99+' : tab.badge}
                </span>
              )}
            </span>
            <span className="gt-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
