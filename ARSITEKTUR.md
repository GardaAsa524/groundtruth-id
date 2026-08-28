# GroundTruth.id — Arsitektur Ekstensi Analitik

Dokumen ini menjelaskan rancangan lima modul baru dan alasan teknis di balik
setiap keputusan yang tidak jelas dari kodenya sendiri.

Seluruh logika inti diuji di Node: `npm test` menjalankan 77 uji yang mencakup
proyeksi, pencocokan affine, reproyeksi bbox, parser ekspresi, evaluator,
kueri atribut, metrik akurasi, dan pemasangan nyata antarmuka di jsdom.

### Mengapa ada uji pemasangan (test/smoke.test.mjs)

Versi pertama yang diterbitkan menampilkan **halaman putih total**, padahal
seluruh uji logika lulus, `vite build` berhasil, dan bundelnya bersih. Dua
cacat lolos dari semua pemeriksaan itu:

1. `<DrawingTools>` memanggil `useMap()` tetapi dirender di panel samping, di
   luar `<MapContainer>`. react-leaflet melempar galat, React membatalkan
   seluruh pohon, dan tidak ada apa pun yang tergambar.
2. Geoman adalah plugin Leaflet gaya lama yang mengacu ke variabel global `L`.
   Dalam bundel ESM, `L` tidak pernah menjadi global.

Keduanya sah secara sintaksis, sehingga esbuild dan Rollup meloloskannya; dan
keduanya tidak menyentuh modul `core/`, sehingga uji logika tidak melihatnya.
Satu-satunya cara menangkapnya sebelum sampai ke lapangan adalah benar-benar
memasang komponennya.

Uji ini melakukan dua hal. Pertama, analisis statis: ia memindai setiap
komponen yang memanggil `useMap()`, lalu memastikan tak satu pun dirender di
luar batas `<MapContainer>` pada `App.jsx`. Kedua, `App` dibundel dengan
esbuild lalu dipasang sungguhan di jsdom, dan hasil render diperiksa tidak
kosong serta bebas galat React.

Pelajaran yang layak dibawa: **bundel yang berhasil dibuat bukan bukti aplikasi
berjalan.** Untuk aplikasi yang dipakai di lapangan, jarak antara keduanya
adalah perjalanan yang sia-sia.

```
src/
├── core/                     logika murni — tanpa React, tanpa DOM, dapat diuji
│   ├── geo/
│   │   ├── projection.js     WGS84 ↔ UTM, konvergensi meridian, pembaca WKT
│   │   ├── affine.js         matriks affine + pencocokan kuadrat terkecil
│   │   └── bounds.js         reproyeksi bbox raster + perkiraan simpangan tempel
│   ├── geopdf/
│   │   ├── parseGeoPDF.js    ekstraksi /VP /Measure /GEO dan LGIDict TerraGo
│   │   ├── georefModel.js    rantai transformasi + anggaran resolusi render
│   │   └── GeoPDFGridLayer.js  ubin yang di-resample per tampilan
│   ├── raster/
│   │   ├── expression.js     lexer, parser, evaluator aljabar peta
│   │   ├── glsl.js           AST → fragment shader; gradien warna
│   │   └── renderer.js       WebGL2, jalur cadangan CPU, statistik, anggaran memori
│   ├── vector/
│   │   └── query.js          skema, pohon aturan, kompilasi predikat, ekspor SQL
│   └── accuracy/
│       └── confusionMatrix.js  OA, UA/PA, F1, Kappa, koreksi luas Olofsson
├── context/AppProviders.jsx  tema, bahasa, dan data proyek (tiga konteks terpisah)
├── hooks/useGeolocation.js   jembatan GPS → React
├── components/               lapisan tipis: DOM, Leaflet, dan perekat
└── i18n/strings.js           tabel datar id/en, diuji paritasnya
```

Pembagian `core/` dan `components/` bukan sekadar kerapian. Seluruh matematika
berada di modul yang tidak menyentuh React atau DOM, sehingga dapat dijalankan
di Web Worker, diuji tanpa jsdom, dan dipakai ulang bila antarmukanya berganti.

---

## 1. GeoPDF luring

### Masalah yang tidak terlihat dari dokumentasi

**PDF.js tidak memaparkan kamus georeferensi.** `PDFPageProxy.getViewport()`
sama sekali tidak berhubungan dengan `/VP` — itu viewport tampilan. Kamus `/VP`
hanya dapat dicapai lewat properti internal yang berubah antarversi.

Karena itu tugasnya dibelah:

| Pustaka | Peran |
|---|---|
| **pdf-lib** | membaca struktur objek PDF, termasuk object stream terkompresi, untuk mengambil `/VP → /Measure → /GPTS, /LPTS, /GCS` |
| **pdf.js** | khusus rasterisasi halaman menjadi piksel |

Keduanya membaca `ArrayBuffer` yang sama. Perlu diperhatikan: pdf.js melepas
(detach) buffer yang diberikan, sehingga `buffer.slice(0)` wajib bila pdf-lib
masih akan dipakai.

Dua encoding ditangani: **OGC/ISO 32000-2** (ArcGIS Pro, QGIS) dan **TerraGo
LGIDict** (`/PieceInfo → /TerraGo → /Private`), yang masih banyak dijumpai pada
berkas lama instansi.

### Algoritma transformasi koordinat

Rantai lengkap dari perangkat keras sampai layar:

```
[1] chip GNSS
[2] Geolocation API      → lintang, bujur WGS 84
[3] forwardUTM()         → koordinat terproyeksi peta (mis. UTM 48S, meter)
[4] crsToUser (affine)   → ruang pengguna PDF (titik, origin kiri-bawah)
[5] userToCanvas         → piksel kanvas pdf.js (origin kiri-atas, Y ke bawah)
[6] GeoPDFGridLayer      → piksel ubin Leaflet
```

Langkah [4] disusun dari empat sudut `GPTS`/`LPTS`. **Dicocokkan dengan kuadrat
terkecil, bukan diambil tiga titik**, karena GPTS hanya menyimpan lima desimal
(≈1,1 m pada lintang Indonesia). Empat sudut yang seharusnya persegi panjang
sempurna menjadi sedikit tidak konsisten; memakai tiga sudut meneruskan seluruh
galat pembulatan satu sudut ke seluruh lembar. Residual pencocokan disimpan dan
ditampilkan sebagai RMSE — pengguna aplikasi uji akurasi berhak tahu berapa
galat yang disumbangkan petanya sendiri.

Langkah [5] membalik sumbu Y. Kekeliruan ini menghasilkan peta yang tampak
terbalik secara vertikal dan merupakan bug paling sering pada integrasi pdf.js.

### Mengapa GridLayer, bukan L.imageOverlay

`imageOverlay` meregangkan gambar ke kotak lintang-bujur, yang mengandaikan
citranya sejajar sumbu lintang-bujur. GeoPDF dari ArcGIS/QGIS hampir selalu
**utara grid** — sisi atas lembar sejajar sumbu Y UTM, bukan meridian.
Selisihnya adalah konvergensi meridian:

> Diuji pada berkas nyata (Bandung, 107,562°E, −6,876°, zona 48S):
> γ = **0,306°**, yang pada lembar setinggi 365 m menimbulkan simpangan
> **±0,98 m** di sudut. Untuk aplikasi uji akurasi, galat sistematis sebesar itu
> langsung mencemari matriks konfusi.

`GeoPDFGridLayer` menggambar tiap ubin 256×256 dengan satu `ctx.setTransform()`
yang diturunkan dari tiga sudut ubin. Di dalam satu ubin, hubungan Web Mercator
↔ CRS peta praktis affine (simpangan < 0,01 piksel di lintang tropis), sehingga
hasilnya tepat secara geometris, hemat memori, dan hanya menggambar yang
terlihat. Neatline dipakai sebagai `clip path` agar margin dan legenda lembar
tidak ikut tampil.

### Anggaran memori render

`chooseRenderScale()` membatasi total piksel, bukan DPI. Kanvas 8000×8000 =
256 MB pada RGBA, dan Safari iOS membuangnya secara diam-diam. Bawaan 24 MP
(≈96 MB) aman di ponsel kelas menengah.

---

## 2. Kalkulator raster

### Parser, bukan `new Function`

Menulis `new Function('b1','b2', 'return ' + expr)` menggoda dan salah.
Ekspresi di GroundTruth.id dapat berasal dari templat indeks yang dibagikan
antarpengguna dan tersimpan di Google Sheets — artinya string tidak tepercaya.
`new Function` pada string semacam itu adalah eksekusi kode arbitrer di dalam
sesi pengguna, lengkap dengan akses ke token webhook mereka. Uji menyertakan
kasus injeksi nyata (`constructor.constructor(...)`, template literal,
akses indeks) yang semuanya ditolak di tingkat lexer.

Alasan kedua yang sama pentingnya: penerjemah GLSL memerlukan AST. Ia tidak
bisa bekerja dari string JavaScript.

Tata bahasa mendukung `+ - * / ^`, perbandingan, kurung, 17 fungsi, konstanta,
dan `where(kondisi, a, b)` sebagai percabangan ramah GPU. Pembagian nol
menghasilkan `NaN` (NoData), bukan `Infinity`.

### Jalur GPU

```
Float32Array per pita → tekstur R32F → shader dari AST → kanvas RGBA → overlay
```

Satu shader dikompilasi ulang tiap kali ekspresi berubah, lalu dipakai untuk
seluruh piksel. Untuk satu tile Sentinel-2 (10.980²) ini berarti ~120 juta
evaluasi yang berjalan paralel; jalur CPU setara memerlukan puluhan detik dan
membekukan antarmuka.

Detail yang menentukan hasil terlihat benar:

- **NoData tidak boleh digambar sebagai nol.** Menggambarnya sebagai nol
  menghasilkan "danau" gelap di tepi citra yang sering disangka air pada NDVI.
  Shader mengembalikan alpha 0 untuk piksel NoData.
- **Peregangan memakai persentil 2–98, bukan min/max.** Satu piksel awan atau
  piksel rusak menarik seluruh rentang sehingga gambar tampak rata.
- **Statistik dihitung dari cuplikan tersistematis**, bukan seluruh piksel;
  galat baku persentil pada n = 100.000 sudah jauh di bawah ketelitian visual.
- **Konteks WebGL dilepas secara eksplisit** lewat `WEBGL_lose_context`.
  Peramban membatasi ~16 konteks per tab dan tidak membebaskannya hanya karena
  kanvasnya dilepas dari DOM.

Jalur cadangan CPU (`renderCPU`) dipakai bila WebGL2 tidak tersedia, dan
berfungsi ganda sebagai kebenaran acuan pada uji regresi.

### Anggaran memori

Satu pita Float32 5000×5000 memakan 100 MB; empat pita Sentinel-2 pada resolusi
penuh = 400 MB sebelum tekstur GPU. `planWorkingSize()` menghitung ukuran kerja
**sebelum** `readRasters()` dipanggil, sehingga desimasi terjadi di dalam
geotiff.js memakai piramida internal — bukan setelah 400 MB mendarat di heap.

### Menempatkan hasilnya di peta

GeoTIFF lapangan di Indonesia hampir selalu UTM 48S/49S, bukan EPSG:4326.
Memberikan bbox terproyeksi apa adanya ke Leaflet berarti menyerahkan koordinat
seperti (9239000, 783000) sebagai derajat. **Leaflet tidak mengeluh** — ia hanya
menampilkan layar kosong, dan pengembang menghabiskan sore hari memeriksa shader
padahal masalahnya di baris bounds. `bboxToLatLngBounds()` menutup celah itu dan
menolak berkas terproyeksi yang tidak memuat GeoKey EPSG, alih-alih menerimanya
diam-diam.

Reproyeksi mencuplik sepanjang **keempat sisi**, bukan hanya sudut, karena tepi
kotak UTM melengkung dalam ruang lintang-bujur. Perilakunya tidak seragam dan
layak dicatat:

> Kelengkungan hanya berpengaruh bila kotaknya **melintasi meridian tengah**.
> Pada kotak 200 × 110 km yang melintasi CM zona 48, ekstremum lintang berada di
> tengah tepi dan sudut saja melewatkan **100 m**. Pada kotak seukuran sama yang
> seluruhnya di timur CM, lintang sepanjang tepi monoton dan sudut sudah cukup —
> selisihnya nol. Kedua perilaku itu terkunci dalam uji, termasuk kasus kontrol.

`estimateOverlaySkew()` menghitung sisa galat dari pendekatan imageOverlay dan
menampilkannya ke pengguna. Ini kompromi sadar, bukan kelalaian:

| Cakupan citra | Simpangan sudut | Keputusan |
|---|---|---|
| 400 m (drone/UAV) | ±1,1 m | imageOverlay memadai |
| 110 km (satu tile Sentinel-2) | ±158 m | ditandai; pakai berkas EPSG:4326 |

Ambangnya 5 m — kira-kira separuh anggaran galat GPS ponsel yang baik. Di bawah
itu, penempelan sederhana bukan sumber galat dominan. Untuk citra luas, jalur
`GeoPDFGridLayer` yang sama dapat dipakai ulang, karena keduanya berbagi modul
affine dan proyeksi.

---

## 3. Penyusun kueri atribut

Pohon aturan berbentuk **data murni**, bukan string atau closure:

```js
{ kind: 'group', op: 'AND', rules: [
    { kind: 'group', op: 'OR', rules: [
        { kind: 'rule', field: 'atap', operator: '=', value: 'Asbes' },
        { kind: 'rule', field: 'atap', operator: '=', value: 'Seng' } ] },
    { kind: 'rule', field: 'luas', operator: '>', value: 100 } ] }
```

Bentuk ini bisa disimpan ke Google Sheets, dibagikan antarpengguna, divalidasi,
dan diterjemahkan menjadi kalimat SQL untuk lampiran metodologi. Reviewer jurnal
akan menanyakan kriteria seleksi sampel; `queryToSQL()` adalah jawabannya.

Bentuk **pohon** (bukan daftar datar) dipilih karena pertanyaan lapangan memang
bersarang — contoh di atas persis berbentuk demikian.

### Dua keputusan kinerja

**Predikat dikompilasi sekali.** Konversi tipe dilakukan saat kompilasi, bukan
per fitur. Untuk 20.000 poligon, itu perbedaan antara ~20 ms dan ~400 ms.

**Hasil berupa `Uint8Array` bitmask, bukan salinan array fitur.** Bitmask untuk
20.000 fitur memakan 20 kB; salinan fiturnya puluhan MB.

**Lapisan Leaflet dibuat sekali dan hanya di-`setStyle`.** Membangun ulang
`L.geoJSON` berarti membuang dan mencipta 20.000 simpul SVG. Di atas 4.000
fitur, renderer beralih ke kanvas karena SVG mulai tersendat.

Perbandingan string sengaja tidak peka huruf besar-kecil: data lapangan selalu
berisi "Asbes", "asbes", dan "ASBES" untuk hal yang sama.

---

## 4. Digitasi vektor

**Leaflet-Geoman, bukan Leaflet.draw.** Leaflet.draw praktis tidak terpelihara
sejak 2017 dan punya bug sentuh yang mengganggu di peramban seluler — tepatnya
lingkungan tempat aplikasi ini dipakai. Geoman menyediakan penyuntingan simpul
dan **snapping**, yang penting saat mendigitasi poligon bersebelahan: batas
tutupan lahan tidak boleh bercelah.

Geoman bukan komponen React. Ia dipasang lewat `useMap()` di dalam `useEffect`,
dengan seluruh listener dilepas saat pembongkaran. `FeatureGroup` disimpan di
`ref`, bukan state, karena isinya berubah pada setiap gerakan vertex.

Ekspor GeoJSON menangani dua hal yang sering terlewat:

- **Anggota `crs` dihilangkan.** RFC 7946 menetapkan CRS84 dan melarang anggota
  `crs`; menyertakannya membuat berkas ditolak beberapa alat modern.
- **Web Share API dipakai lebih dahulu di iOS.** Safari iOS lama mengabaikan
  atribut `download`, sehingga berkas terbuka sebagai teks alih-alih terunduh —
  kegagalan senyap yang membuat pengguna mengira datanya hilang.
- Geometri lingkaran tidak ada di GeoJSON; radiusnya disimpan sebagai properti
  `radius_m` agar informasinya tidak lenyap.

---

## 5. Indikator akurasi GPS

Tiga hal yang tidak terlihat dari dokumentasi Geolocation API tetapi menentukan
mutu data lapangan:

**`accuracy` adalah radius kepercayaan 68% (satu sigma), bukan batas galat
maksimum.** Sekitar sepertiga fix berada di luar lingkaran yang digambar. Ini
dinyatakan lewat teks, bukan hanya gambar, karena gambar cenderung dibaca
sebagai jaminan.

**Fix pertama berasal dari cache jaringan** (akurasi ratusan meter), baru
disusul fix GNSS. Merekam sampel pada fix pertama adalah sumber bias spasial
yang halus dan sistematis. Hook menandai fix yang belum matang (`warmingUp`)
dan sakelar validasi tetap terkunci.

**Peramban tidak memberi tahu ketika sinyal hilang** — ia hanya berhenti
memanggil callback. Tanpa pemeriksaan fix basi, penanda tetap tampak sah padahal
posisinya sudah lama tidak diperbarui.

Lingkaran memakai `L.Circle` (radius meter, ikut berskala), bukan
`L.CircleMarker` (radius piksel). Kekeliruan itu membuat akurasi 4 m tampak
seperti 400 m pada zoom rendah.

`safeToSample` menggabungkan seluruh syarat menjadi satu jawaban, dan tombol
Truth/False dinonaktifkan bila akurasi melampaui toleransi — mencegah bias di
sumbernya, bukan sekadar menandainya setelah terjadi.

---

## 6. Galeri peta dasar

Definisi disimpan sebagai data murni sehingga dapat diuji, diserialkan, dan
diperluas tanpa menyentuh komponen.

**Satu catatan lisensi yang perlu keputusan sadar.** Endpoint ubin Google
(`mt{s}.google.com/vt`) dipakai luas di QGIS dan tutorial Leaflet, tetapi berada
di luar ketentuan Google Maps Platform: ToS mewajibkan akses lewat Maps
JavaScript API atau Map Tiles API berbayar. Untuk aplikasi internal risikonya
kecil; untuk produk yang dipublikasikan atas nama **MangGIS.co**, ini paparan
hukum yang nyata.

Karena itu entri Google ditandai `requiresReview: true` dan **disembunyikan
secara bawaan**; pengguna harus mengaktifkannya di Pengaturan. Esri World
Imagery, OSM, dan Carto bebas dipakai dengan atribusi dan merupakan jalur aman.

Detail integrasi react-leaflet: `key` pada `TileLayer` disetel ke id basemap.
Tanpa itu, react-leaflet memperbarui URL pada instans `L.TileLayer` yang sama;
Leaflet menanganinya dengan buruk dan menyisakan ubin penyedia sebelumnya
selama beberapa detik.

---

## 7. Tema dinamis

Tiga konteks terpisah, bukan satu:

| Konteks | Frekuensi perubahan |
|---|---|
| `LocaleContext` | sangat jarang |
| `ThemeContext` | jarang |
| `ProjectContext` | sering, dibaca panel terkait saja |

Menggabungkan ketiganya berarti setiap geseran penggeser transparansi merender
ulang tabel atribut 20.000 baris.

**Instans peta Leaflet tidak pernah masuk state React**; ia disimpan di `ref`.
Menaruhnya di `useState` memicu render ulang pada tiap perubahan internal
Leaflet dan merupakan sumber tersendat paling umum pada aplikasi react-leaflet.

Dataset besar (array piksel, FeatureCollection) disimpan di `useRef(new Map())`,
bukan state. State hanya memegang metadata ringan, sehingga memuat GeoTIFF
200 MB tidak menyebabkan React membandingkan struktur sebesar itu tiap render.
`removeLayer()` membebaskan tekstur GPU dan mencabut object URL secara eksplisit
— GPU tidak mengumpulkan tekstur hanya karena referensi JS-nya hilang.

Tema diterapkan lewat `data-theme` pada `<html>` agar variabel CSS berlaku juga
untuk kontrol Leaflet yang berada di luar pohon React. Sinkronisasi ke basemap
gelap berjalan selama `followTheme` aktif; begitu pengguna memilih basemap
sendiri, sinkronisasi berhenti mengganggu pilihannya.

---

## Catatan metodologis untuk modul akurasi

Dua hal yang perlu diketahui sebelum melaporkan angka dari aplikasi ini.

**Overall Accuracy mentah hanya sahih pada sampel acak sederhana.** Hampir semua
uji akurasi memakai *stratified random sampling* per kelas peta, dan pada
rancangan itu OA mentah bias karena kelas langka terwakili berlebih.
`computeAreaAdjusted()` menerapkan koreksi Olofsson et al. (2014):
sel matriks diubah dari hitungan sampel menjadi proporsi luas
`p_ij = W_i · n_ij / n_i`. Fungsi ini juga menghasilkan **luas terkoreksi
beserta selang kepercayaannya** — yang justru sering menjadi keluaran utama
yang diminta reviewer, bukan akurasinya.

> Contoh dari uji: OA mentah 0,8667 versus terboboti luas 0,8714 pada matriks
> yang sama. Selisihnya kecil di sini karena strata cukup seimbang; pada peta
> dengan kelas perubahan yang langka, selisihnya bisa puluhan persen.

**Kappa disediakan tetapi jangan diandalkan.** Literatur mutakhir
(Pontius & Millones 2011; Foody 2020) menyarankan agar Kappa tidak dijadikan
metrik utama: ia menghukum akurasi tinggi pada kelas tidak seimbang dan sulit
ditafsirkan. Ia disertakan karena masih diminta banyak instansi.

**Sakelar biner Truth/False punya batas yang keras.** Bila pengguna hanya
mencatat "benar/salah" tanpa kelas rujukan, data itu hanya dapat menghasilkan
*User's Accuracy* per kelas peta. *Producer's Accuracy*, F1, dan Kappa mustahil
dihitung karena kolom rujukan tidak pernah terisi.
`computeBinaryValidation()` menghitung apa yang sah dan **menyatakan secara
eksplisit apa yang tidak**, agar pengguna tidak melaporkan angka yang tidak
dapat dipertahankan.

---

## Menjalankan

```bash
npm install
npm run dev       # server pengembangan Vite
npm test          # 60 uji logika inti
npm run build     # bundel produksi dengan pemecahan chunk manual
```

Bundel dipecah manual: pdf.js + geotiff + shpjs (~1,6 MB) tidak boleh masuk
bundel awal, karena sebagian besar pengguna hanya membuka peta.

**Geolocation memerlukan konteks aman.** Pada `file://` atau `http://` non-
localhost, permintaan gagal dengan `PERMISSION_DENIED` yang menyesatkan —
`useGeolocation` mendeteksinya lebih dahulu dan memberi pesan yang benar.

---

## Yang belum ada di kode ini

Supaya perencanaan berikutnya berpijak pada keadaan sebenarnya:

- **Resampling raster per ubin.** Bbox GeoTIFF kini direproyeksi dengan benar
  (`core/geo/bounds.js`), tetapi penempatannya masih memakai `imageOverlay`.
  Untuk citra berskala puluhan kilometer, simpangan konvergensi ditandai ke
  pengguna namun belum dikoreksi; koreksinya berarti memindahkan raster ke
  jalur `GeoPDFGridLayer`.
- **CRS di luar UTM dan EPSG:4326.** `makeTransformer()` menolak dengan pesan
  yang jelas dan meminta proj4js dimuat, tetapi pemuatan otomatisnya belum ada.
- **Webhook Google Sheets.** Modul pengiriman disebut dalam ringkasan tetapi
  tidak termasuk dalam lima modul yang diminta; antarmukanya sudah disiapkan
  lewat `ProjectContext`.
- **Web Worker.** Parser dan evaluator sengaja bebas DOM sehingga siap
  dipindahkan ke worker, tetapi pemindahannya belum dilakukan.
- **Uji GPU.** Shader diverifikasi secara struktural (paritas kurung, pengikatan
  sampler, format literal), bukan secara numerik — itu memerlukan konteks WebGL
  yang tidak tersedia di lingkungan uji Node.
- **Ekspor raster resolusi penuh.** `renderTiled` disebut di komentar sebagai
  jalur yang direncanakan; implementasinya belum ada.
