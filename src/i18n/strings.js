/**
 * i18n/strings.js — tabel string datar.
 * Struktur datar (bukan bersarang) dipilih agar kunci yang hilang mudah
 * ditemukan dengan grep dan agar tidak ada penelusuran objek saat render.
 * Uji paritas kunci ada di test/i18n.test.mjs — terjemahan yang terlewat
 * adalah cacat yang paling sering lolos ke produksi pada aplikasi dwibahasa.
 */
export const STRINGS = {
  id: {
    'app.title': 'GroundTruth.id',
    'app.subtitle': 'Survei lapangan & uji akurasi spasial',
    'nav.map': 'Peta', 'nav.data': 'Data', 'nav.raster': 'Raster',
    'nav.query': 'Kueri', 'nav.accuracy': 'Akurasi', 'nav.settings': 'Pengaturan',

    'gps.active': 'GPS aktif', 'gps.stale': 'Sinyal GPS tertahan',
    'gps.status.idle': 'GPS mati', 'gps.status.requesting': 'Mencari sinyal…',
    'gps.status.denied': 'Izin lokasi ditolak', 'gps.status.unavailable': 'GPS tidak tersedia',
    'gps.status.insecure': 'Perlu HTTPS', 'gps.status.active': 'GPS aktif',
    'gps.lat': 'Lintang', 'gps.lon': 'Bujur', 'gps.accuracy': 'Akurasi', 'gps.altitude': 'Ketinggian',
    'gps.warmingUp': 'Penerima sedang matang; fix pertama biasanya berasal dari jaringan, bukan satelit.',
    'gps.overTolerance': 'Akurasi ±{acc} m melampaui toleransi {tol} m. Merekam sampel sekarang berisiko bias spasial.',
    'gps.sigmaNote': 'Radius akurasi adalah lingkaran kepercayaan 68%, bukan batas galat maksimum.',

    'basemap.title': 'Peta dasar', 'basemap.followTheme': 'Ikuti tema',
    'basemap.licenceWarn': 'periksa lisensi',
    'basemap.googleHidden': 'Layanan Google disembunyikan karena berada di luar ketentuan Maps Platform. Aktifkan di Pengaturan bila risikonya sudah ditinjau.',

    'geopdf.crs': 'Sistem koordinat', 'geopdf.fitRmse': 'RMSE kecocokan sudut',
    'geopdf.convergence': 'Konvergensi meridian', 'geopdf.groundRes': 'Resolusi tanah',
    'geopdf.canvasSize': 'Ukuran kanvas',
    'geopdf.rmseWarn': 'RMSE {rmse} m di atas ambang wajar. Periksa apakah proyeksi berkas benar.',

    'raster.noFile': 'Muat berkas GeoTIFF untuk memulai.',
    'raster.expression': 'Ekspresi aljabar peta', 'raster.usedBands': 'Pita terpakai',
    'raster.availableBands': 'Pita tersedia', 'raster.colormap': 'Gradien warna',
    'raster.stretch': 'Peregangan', 'raster.stretchPercentile': 'Persentil 2–98',
    'raster.stretchFixed': 'Rentang tetap', 'raster.opacity': 'Transparansi',
    'raster.compute': 'Hitung dan tampilkan', 'raster.computing': 'Menghitung…',
    'raster.sourceInfo': 'Informasi berkas sumber', 'raster.fullSize': 'Ukuran penuh',
    'raster.workingSize': 'Ukuran kerja', 'raster.bands': 'Jumlah pita',
    'raster.placement': 'Penempatan', 'raster.overlaySkew': 'Simpangan tempel',
    'raster.skewWarn': 'Citra ditempel ke kotak lintang-bujur, sehingga konvergensi meridian menimbulkan simpangan sekitar {m} m di sudut. Untuk uji akurasi pada cakupan seluas ini, gunakan berkas yang sudah direproyeksi ke EPSG:4326.',

    'query.noData': 'Muat berkas GeoJSON atau Shapefile untuk memulai.',
    'query.selectField': 'pilih kolom', 'query.addRule': 'aturan', 'query.addGroup': 'grup',
    'query.removeRule': 'Hapus aturan', 'query.emptyGroup': 'Grup kosong meloloskan semua fitur.',
    'query.featuresMatched': 'fitur cocok', 'query.summarize': 'Ringkas kolom',

    'draw.hint': 'Gambar poligon, garis, atau titik langsung di peta untuk memetakan area observasi baru.',
    'draw.featureCount': 'geometri tergambar', 'draw.clear': 'Kosongkan',
    'draw.export': 'Unduh {n} geometri (GeoJSON)', 'draw.exporting': 'Menyiapkan…',

    'validation.truth': 'Sesuai', 'validation.false': 'Tidak sesuai',
    'validation.question': 'Apakah kelas peta di titik ini sesuai kondisi lapangan?',
    'accuracy.oa': 'Overall Accuracy', 'accuracy.kappa': 'Koefisien Kappa',
    'accuracy.macroF1': 'Macro F1', 'accuracy.ua': "User's Accuracy",
    'accuracy.pa': "Producer's Accuracy",

    'theme.toggle': 'Ganti tema', 'locale.toggle': 'English',
  },
  en: {
    'app.title': 'GroundTruth.id',
    'app.subtitle': 'Field survey & spatial accuracy assessment',
    'nav.map': 'Map', 'nav.data': 'Data', 'nav.raster': 'Raster',
    'nav.query': 'Query', 'nav.accuracy': 'Accuracy', 'nav.settings': 'Settings',

    'gps.active': 'GPS active', 'gps.stale': 'GPS signal stalled',
    'gps.status.idle': 'GPS off', 'gps.status.requesting': 'Acquiring signal…',
    'gps.status.denied': 'Location permission denied', 'gps.status.unavailable': 'GPS unavailable',
    'gps.status.insecure': 'HTTPS required', 'gps.status.active': 'GPS active',
    'gps.lat': 'Latitude', 'gps.lon': 'Longitude', 'gps.accuracy': 'Accuracy', 'gps.altitude': 'Altitude',
    'gps.warmingUp': 'Receiver is settling; the first fix usually comes from the network, not satellites.',
    'gps.overTolerance': 'Accuracy ±{acc} m exceeds the {tol} m tolerance. Sampling now risks spatial bias.',
    'gps.sigmaNote': 'The accuracy radius is a 68% confidence circle, not a maximum error bound.',

    'basemap.title': 'Basemap', 'basemap.followTheme': 'Follow theme',
    'basemap.licenceWarn': 'check licence',
    'basemap.googleHidden': 'Google services are hidden because they fall outside Maps Platform terms. Enable in Settings once the risk has been reviewed.',

    'geopdf.crs': 'Coordinate system', 'geopdf.fitRmse': 'Corner fit RMSE',
    'geopdf.convergence': 'Meridian convergence', 'geopdf.groundRes': 'Ground resolution',
    'geopdf.canvasSize': 'Canvas size',
    'geopdf.rmseWarn': 'RMSE {rmse} m exceeds the expected bound. Verify the file projection.',

    'raster.noFile': 'Load a GeoTIFF to begin.',
    'raster.expression': 'Map algebra expression', 'raster.usedBands': 'Bands used',
    'raster.availableBands': 'Available bands', 'raster.colormap': 'Colour ramp',
    'raster.stretch': 'Stretch', 'raster.stretchPercentile': '2–98 percentile',
    'raster.stretchFixed': 'Fixed range', 'raster.opacity': 'Opacity',
    'raster.compute': 'Compute and display', 'raster.computing': 'Computing…',
    'raster.sourceInfo': 'Source file details', 'raster.fullSize': 'Full size',
    'raster.workingSize': 'Working size', 'raster.bands': 'Band count',
    'raster.placement': 'Placement', 'raster.overlaySkew': 'Overlay skew',
    'raster.skewWarn': 'The image is pinned to a lat/lon box, so meridian convergence introduces roughly {m} m of skew at the corners. For accuracy assessment at this extent, use a file already reprojected to EPSG:4326.',

    'query.noData': 'Load a GeoJSON or Shapefile to begin.',
    'query.selectField': 'select field', 'query.addRule': 'rule', 'query.addGroup': 'group',
    'query.removeRule': 'Remove rule', 'query.emptyGroup': 'An empty group passes every feature.',
    'query.featuresMatched': 'features matched', 'query.summarize': 'Summarise field',

    'draw.hint': 'Draw polygons, lines, or points directly on the map to delineate new observation areas.',
    'draw.featureCount': 'features drawn', 'draw.clear': 'Clear',
    'draw.export': 'Download {n} features (GeoJSON)', 'draw.exporting': 'Preparing…',

    'validation.truth': 'Match', 'validation.false': 'Mismatch',
    'validation.question': 'Does the map class at this point match field conditions?',
    'accuracy.oa': 'Overall Accuracy', 'accuracy.kappa': 'Kappa coefficient',
    'accuracy.macroF1': 'Macro F1', 'accuracy.ua': "User's Accuracy",
    'accuracy.pa': "Producer's Accuracy",

    'theme.toggle': 'Toggle theme', 'locale.toggle': 'Bahasa Indonesia',
  },
};
