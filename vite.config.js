import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Nama repositori GitHub Pages.
 *
 * GitHub Pages menaruh situs proyek di sub-folder (username.github.io/NAMA/),
 * bukan di akar. Vite bawaannya mengandaikan akar, sehingga seluruh aset gagal
 * dimuat dan yang tampil hanya halaman putih tanpa pesan galat apa pun.
 * Ubah baris ini bila nama repo Anda berbeda. Jadikan '/' bila dipasang di
 * domain sendiri, Netlify, atau Vercel.
 */
const REPO = '/groundtruth-id/';   // sesuaikan bila nama repo berbeda

export default defineConfig(({ command }) => ({
  // Saat `npm run dev`, base harus '/' agar server pengembangan bekerja normal.
  base: command === 'build' ? REPO : '/',

  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png'],

      manifest: {
        name: 'REIS — Remote Sensing Evaluation & Inspection Survey',
        short_name: 'REIS',
        description: 'Survei lapangan dan uji akurasi pengindraan jauh oleh MangGIS.co',
        lang: 'id',
        start_url: REPO,
        scope: REPO,
        display: 'standalone',
        orientation: 'any',
        background_color: '#0c1512',
        theme_color: '#0c1512',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Seluruh berkas program di-precache supaya aplikasi terbuka penuh
        // tanpa jaringan. Batas besar ini disengaja: pdf.worker sendiri 1,4 MB,
        // dan justru berkas itulah yang wajib tersedia luring karena GeoPDF
        // dibuka di lapangan, bukan di kantor.
        // pdf disertakan dengan sengaja: modul penggunaan justru paling
        // dibutuhkan di lapangan, tepat ketika tidak ada jaringan untuk
        // mengunduhnya.
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,woff2,pdf}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,

        // Ubin peta TIDAK di-precache — jumlahnya tak terhingga. Ia disimpan
        // saat dilihat, dengan batas tegas supaya penyimpanan ponsel tidak
        // habis diam-diam.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-d]?\.?(tile\.openstreetmap\.org|basemaps\.cartocdn\.com)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ubin-osm',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ubin-esri',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],

        // Tanpa ini, memuat ulang halaman saat luring menghasilkan 404 dari
        // service worker alih-alih membuka aplikasi.
        navigateFallback: `${REPO}index.html`,
        cleanupOutdatedCaches: true,
      },

      devOptions: { enabled: false },
    }),
  ],

  build: {
    target: 'es2022',            // BigInt & top-level await dipakai geotiff.js
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-map': ['leaflet', 'react-leaflet'],
          'vendor-pdf': ['pdf-lib', 'pdfjs-dist'],
          'vendor-proj': ['proj4'],
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },

  worker: { format: 'es' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
}));
