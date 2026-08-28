# Memasang GroundTruth.id di Ponsel

## Ringkas

Aplikasi ini dipasang sebagai **PWA** — dibuka dari peramban, lalu ditambahkan
ke layar utama sehingga tampil dan berperilaku seperti aplikasi biasa: ikon
sendiri, layar penuh tanpa bilah alamat, dan bekerja tanpa jaringan.

Ini pendekatan yang sama dengan aplikasi survei pohon BMTI.

---

## Mengapa bukan berkas HTML tunggal

Ini pertanyaan yang wajar, tetapi jawabannya menutup pilihan tersebut.

Berkas HTML yang dibuka langsung dari penyimpanan ponsel berjalan pada skema
`file://`. Di sana **Geolocation API menolak bekerja** — spesifikasinya
mensyaratkan *secure context*, dan `file://` tidak memenuhinya. Indikator lokasi
tidak akan pernah menyala, dan seluruh modul akurasi GPS menjadi sia-sia.

Selain itu, service worker juga hanya dapat didaftarkan di HTTPS, sehingga
kemampuan luring ikut hilang.

`useGeolocation` mendeteksi keadaan ini dan menampilkan pesan "Perlu HTTPS",
bukan "izin ditolak" yang menyesatkan seperti pesan bawaan peramban. Tetapi
mendeteksi bukan berarti bisa mengatasi.

**Kesimpulannya:** aplikasi ini harus dilayani lewat HTTPS, apa pun bentuk
kemasannya. Satu berkas HTML hanya memudahkan pengunggahan, bukan membuatnya
bisa dibuka langsung dari penyimpanan.

---

## Mengapa bukan APK

APK bisa dibuat, lewat Capacitor. Tetapi untuk aplikasi ini, APK memberi sedikit
dan mengambil banyak.

| | PWA | APK (Capacitor) |
|---|---|---|
| GPS + akurasi | ya | ya |
| Bekerja luring | ya | ya |
| Ikon di layar utama, layar penuh | ya | ya |
| Buka berkas GeoPDF/GeoTIFF | ya | ya |
| Unduh hasil ke penyimpanan | ya | ya |
| Berjalan di iPhone | ya | perlu build terpisah + Mac |
| Memperbarui aplikasi | otomatis | kirim ulang APK ke tiap surveyor |
| Perkakas yang harus dipasang | tidak ada | Android Studio + JDK, ~6 GB |
| Lokasi latar belakang | tidak | ya |
| Terbit di Play Store | tidak | ya |

Dua baris terakhir adalah satu-satunya keunggulan nyata APK — dan aplikasi ini
tidak memerlukan keduanya. Perekaman titik selalu dilakukan sambil melihat
layar, jadi lokasi latar belakang tidak relevan.

Sebaliknya, baris "memperbarui aplikasi" adalah beban nyata di lapangan. Dengan
PWA, perbaikan yang Anda terbitkan pagi ini sudah dipakai surveyor siang itu
juga. Dengan APK, Anda harus mengirim berkas baru ke setiap orang dan memastikan
mereka memasangnya.

Bila kelak Anda benar-benar memerlukan APK — misalnya karena syarat pengadaan
instansi — Capacitor dapat membungkus hasil build yang sama tanpa mengubah satu
baris pun kode aplikasi:

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap init GroundTruth id.manggis.groundtruth --web-dir=dist
npx cap add android
npm run build && npx cap sync
npx cap open android        # membuka Android Studio untuk membangun APK
```

Langkah terakhir memerlukan Android Studio terpasang di komputer Anda.

---

## Cara memasang: lewat GitHub Pages

### Sekali saja

1. Buat repositori baru di GitHub, misalnya `groundtruth-id`.
2. Buka `vite.config.js`, sesuaikan baris paling atas dengan nama repo Anda:

   ```js
   const REPO = '/groundtruth-id/';
   ```

   Bila namanya berbeda, aset akan gagal dimuat dan yang tampil hanya **halaman
   putih tanpa pesan galat apa pun**. Ini kesalahan paling sering pada
   penerbitan ke GitHub Pages, dan gejalanya sama sekali tidak menunjuk ke
   penyebabnya.

3. Unggah seluruh isi folder proyek ini ke repo tersebut.
4. Di GitHub: **Settings → Pages → Source**, pilih **GitHub Actions**.

Selesai. Alur kerja `.github/workflows/deploy.yml` akan berjalan sendiri: ia
menjalankan 66 uji lebih dahulu, lalu membangun, lalu menerbitkan. Bila ada uji
yang gagal, penerbitan berhenti — aplikasi cacat tidak akan sampai ke lapangan.

Alamatnya menjadi:

```
https://NAMAAKUN.github.io/groundtruth-id/
```

Anda tidak perlu memasang Node.js di laptop sama sekali dengan cara ini.

### Setiap kali ada perubahan

Push ke cabang `main`. Sisanya otomatis, sekitar dua menit.

---

## Cara memasang di ponsel surveyor

**Android (Chrome)**

1. Buka alamat di atas.
2. Tunggu peta muncul.
3. Menu tiga titik → **Tambahkan ke Layar utama** (atau muncul sendiri sebagai
   tawaran "Instal aplikasi").

**iPhone (wajib Safari, bukan Chrome)**

1. Buka alamat di atas di **Safari**.
2. Tombol Bagikan (kotak dengan panah ke atas) → **Tambah ke Layar Utama**.

Chrome di iOS tidak dapat memasang PWA — batasan iOS, bukan bug. Bila surveyor
melaporkan menu itu tidak ada, hampir pasti mereka memakai Chrome.

---

## Menyiapkan sebelum ke lapangan

Pemuatan pertama mengunduh sekitar **1 MB** (3,2 MB setelah dibuka), lalu
seluruh program tersimpan di ponsel. Sesudah itu aplikasi terbuka penuh tanpa
jaringan.

Yang **tidak** ikut tersimpan otomatis adalah ubin peta dasar — jumlahnya tak
terhingga, jadi tidak mungkin di-precache. Ubin disimpan saat dilihat, dengan
batas 3.000 ubin per penyedia dan masa simpan 30 hari.

Artinya, sama seperti aplikasi survei pohon: **buka dan perbesar area kerja
selagi masih ada sinyal.** Ubin yang belum pernah tampil akan menjadi kotak
kosong di lapangan.

Untuk GeoPDF, hal ini tidak berlaku — berkasnya dibaca dari penyimpanan ponsel,
jadi selalu tersedia luring. Itulah alasan modul GeoPDF ada.

---

## Pembaruan aplikasi

Ketika versi baru terbit, muncul bilah kecil "Versi baru tersedia" dengan tombol
Perbarui. Pembaruan **tidak** dipasang otomatis.

Ini disengaja. Pembaruan otomatis dapat memuat ulang halaman di tengah pengisian
formulir observasi dan membuang isian yang belum tersimpan. Surveyor memutuskan
sendiri kapan waktunya aman.

---

## Menguji cepat tanpa menerbitkan

```bash
npm install
npm run dev -- --host
```

Terminal mencetak alamat jaringan lokal, misalnya `http://192.168.1.7:5173`.
Anda bisa membukanya dari ponsel di Wi-Fi yang sama — **tetapi GPS tidak akan
bekerja**, karena `http://` bukan konteks aman. Berguna untuk memeriksa tata
letak, tidak berguna untuk menguji modul akurasi.

Untuk menguji GPS di ponsel, jalur tercepat adalah menerbitkan ke GitHub Pages.
Alternatifnya, gunakan terowongan HTTPS sementara seperti `cloudflared tunnel`
atau `ngrok` yang memberi alamat HTTPS asli.

---

## Bila terjadi masalah

| Gejala | Penyebab yang paling mungkin |
|---|---|
| Halaman putih kosong | `REPO` di `vite.config.js` tidak cocok dengan nama repo |
| GPS tidak menyala, tertulis "Perlu HTTPS" | dibuka lewat `http://` atau `file://` |
| Menu "Tambah ke Layar Utama" tidak ada di iPhone | memakai Chrome, harus Safari |
| Peta kotak kosong di lapangan | area kerja belum pernah dibuka selagi ada sinyal |
| Perubahan kode tidak muncul | service worker menyajikan versi lama; tekan Perbarui pada bilah pemberitahuan |
| Tombol Truth/False tertutup di iPhone | pastikan memakai `index.html` versi ini, yang sudah memuat `viewport-fit=cover` |
