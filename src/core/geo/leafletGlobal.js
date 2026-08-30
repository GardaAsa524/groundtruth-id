/**
 * core/geo/leafletGlobal.js
 * ---------------------------------------------------------------------------
 * Menyediakan Leaflet sebagai variabel global sebelum plugin gaya lama dimuat.
 *
 * MENGAPA MODUL SEKECIL INI PERLU ADA TERSENDIRI
 * ----------------------------------------------
 * Plugin Leaflet generasi lama — Geoman termasuk — mengacu ke variabel global
 * `L`, bukan mengimpor leaflet sebagai modul. Dalam bundel ESM, `L` tidak
 * pernah menjadi global, sehingga plugin gagal dimuat.
 *
 * Penetapan globalnya tidak bisa ditaruh di berkas yang sama dengan impor
 * plugin: ESM mengangkat seluruh impor ke atas, sehingga badan modul plugin
 * berjalan sebelum baris penetapan mana pun. Yang dijamin spesifikasi adalah
 * URUTAN ANTARMODUL — modul yang diimpor lebih dahulu dievaluasi lebih dahulu.
 * Karena itu penetapannya dipindahkan ke modul tersendiri, lalu diimpor tepat
 * sebelum plugin.
 *
 * Ditulis ke globalThis, bukan window: di peramban keduanya objek yang sama,
 * tetapi pencarian variabel bebas selalu berakhir di globalThis.
 */

import L from 'leaflet';

if (typeof globalThis !== 'undefined' && !globalThis.L) {
  globalThis.L = L;
}

export default L;
