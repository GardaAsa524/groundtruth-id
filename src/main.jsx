import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/tokens.css';
import { registerSW } from 'virtual:pwa-register';

/**
 * Pendaftaran service worker.
 *
 * registerType 'prompt' dipakai, bukan 'autoUpdate'. Alasannya penting untuk
 * aplikasi lapangan: pembaruan otomatis dapat memuat ulang halaman di tengah
 * pengisian formulir observasi dan membuang isian yang belum tersimpan.
 * Surveyor memutuskan sendiri kapan waktunya aman untuk memperbarui.
 */
const updateSW = registerSW({
  onNeedRefresh() {
    const el = document.getElementById('gt-update-bar');
    if (el) el.hidden = false;
  },
  onOfflineReady() {
    const el = document.getElementById('gt-offline-bar');
    if (!el) return;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  },
});

document.getElementById('gt-update-now')?.addEventListener('click', () => updateSW(true));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
