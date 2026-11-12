# PRD — Ruang Kontrol Auto-Edit Video Iklan

Versi: v0.2 (draf) · 12 November 2026 · menggantikan v0.1 (11 November 2026)

## Ringkasan

Ruang Kontrol Auto-Edit adalah dashboard internal tempat tim membuat, mengoreksi, dan merender video iklan. Video mentah masuk, mesin membuat **draf edit pertama** (transkrip, potongan, caption, kata kunci, hook, efek, SFX), lalu tim mengoreksinya langsung di dashboard dengan preview yang berubah seketika, dan merender MP4.

Semua bahan editing dikelola di dashboard dan bisa terus ditambah: **library aset** (SFX, musik, font, logo, b-roll) dan **preset gaya** per brand × jenis konten. Preset menggantikan file skill per brand. Tim tidak perlu menulis skill dan tidak perlu mengontrol edit lewat Telegram.

**Status dokumen: v0.2, draf.** Mesin edit (`pipeline/jalan.py`) sudah jalan end-to-end di video uji, tapi belum lulus uji 5–10 video. Angka target di sini masih asumsi.

### Yang berubah dari v0.1

| Bagian | v0.1 | v0.2 |
| --- | --- | --- |
| Pusat kontrol | Dashboard + Telegram, gaya edit di file skill per brand | Dashboard saja. Gaya edit = preset (data) yang diubah lewat dashboard |
| Bahan editing | Folder brand diisi manual | Library aset di dashboard: upload, tag, putar, status lisensi |
| Koreksi hasil | Centang potongan + catatan revisi. Editor timeline di luar scope | Editor dengan preview langsung (L1), lalu timeline ringan (L2). CapCut penuh (L3) tetap di luar scope |
| Otak edit | Claude Code membaca skill tiap video | **Hybrid**: aturan dari preset dijalankan kode; keputusan yang butuh "paham" oleh Claude API; Claude Code sebagai engineer, bukan operator harian |
| Telegram | Notifikasi + perintah | Tidak dipakai untuk kontrol. Notifikasi opsional, nanti |
| Prototipe | Google Canvas dengan data contoh | Dibangun langsung di project ini, memakai Remotion Player dan data sungguhan |
| Form gaya edit (.docx) | Bahan untuk menulis skill | Bahan awal preset. Setelah dashboard ada, form diisi langsung di dashboard |

## Tujuan & ukuran keberhasilan

Tujuannya mengurangi waktu edit video iklan tanpa menurunkan kualitas tayang. Gaya brand harus bisa diubah sendiri oleh tim tanpa menyentuh kode atau skill.

| Ukuran | Target v1 | Cara mengukur |
| --- | --- | --- |
| Video layak tayang tanpa koreksi manual | ≥ 7 dari 10 | Dinilai PIC brand per video (Lulus / Revisi) |
| Video layak tayang setelah koreksi di dashboard, tanpa bantuan engineer | ≥ 9 dari 10 | Job yang selesai tanpa permintaan perubahan kode |
| Waktu ubah gaya brand (mis. ganti font caption) | < 2 menit, terlihat langsung di preview | Uji manual |
| Waktu dari upload sampai draf siap dikoreksi | Ditentukan setelah uji coba | Timestamp tiap tahap di `job.json` |
| Revisi rata-rata per video | ≤ 2 | Jumlah versi per job |
| Pelanggaran aturan (angka karangan, kata terlarang, teks menutup wajah) | 0 | Laporan QC otomatis + review |
| Biaya AI & waktu render per video | Ditentukan setelah uji coba | Dicatat per job |

## Pengguna & peran

| Peran | Siapa | Boleh melakukan |
| --- | --- | --- |
| Owner | Pemilik bisnis | Semua: kelola brand, preset, aset, pengguna; hapus job |
| PIC brand / editor | Editor senior per brand | Buat job, koreksi draf, render, nilai, ubah preset & aset brand-nya |
| Tim konten | Kreator / admin konten | Upload video + brief, lihat job miliknya, unduh hasil |
| Engineer | Claude Code di PC kantor, diarahkan Owner | Menambah efek/komponen baru, memperbaiki mesin. Tidak ikut alur harian |

v1 hanya diakses dari jaringan kantor tanpa login. Pembatasan per peran dan per brand masuk Fase 3 bersama login (lihat K-5).

## Arsitektur: hybrid

```
 Tim (browser, jaringan kantor)
        │
        ▼
 Dashboard (dashboard/, React + Remotion Player)
        │  HTTP /api/...
        ▼
 Server lokal (server/, Node) ── antrean job, file JSON di disk
        │
        ├─ pipeline/ (Python): Whisper → rencana edit (aturan preset) → props
        ├─ Claude API (opsional, Fase 3): keputusan take ulang, hook, kata kunci, efek
        └─ Remotion render (komposisi src/AdVideo) → jobs/<id>/out/vNN.mp4

 Claude Code = engineer: membangun & memelihara semua di atas.
```

**Siapa memutuskan apa**

| Keputusan | Dikerjakan oleh | Sumber aturan |
| --- | --- | --- |
| Transkrip per kata | Whisper (lokal) | Kosakata & kamus kata di brand kit |
| Buang jeda diam, "eee" | Kode (aturan) | Preset: jeda maksimum, daftar kata pengisi |
| Gaya caption, warna, font, posisi, animasi | Kode (aturan) | Preset |
| SFX tiap teks besar / transisi, logo, ending | Kode (aturan) | Preset + library aset |
| Take ulang mana yang dibuang | v1: aturan sederhana + koreksi tim. Fase 3: Claude API | Preset + transkrip |
| Kata kunci, teks hook, penempatan efek | v1: aturan (`pipeline/edit.py`). Fase 3: Claude API | Preset + brief |
| Efek baru yang belum ada | Engineer (Claude Code) | Permintaan Owner |

**Kontrak data inti: timeline.** Satu versi video = satu file `timeline.json` yang isinya mengikuti `adVideoSchema` di `src/AdVideo/schema.ts` (potongan, caption per kata, kata kunci, hook, framing, zoom-through, SFX, musik, gaya). Mesin menulis draf ke file ini, dashboard mengedit file yang sama, Remotion merender dari file itu. Tidak ada jalur ketiga.

**Teknologi yang disetujui** (dependency baru di luar daftar ini = keputusan Owner):

- Frontend: Vite + React + TypeScript, `@remotion/player` (versi sama dengan `remotion`, saat ini 4.0.542).
- Server: Node + Express, `multer` untuk upload, `@remotion/renderer` untuk render dengan progress.
- Validasi: `zod` (sudah ada), skema dipakai bersama dashboard & server.
- Test: `vitest` untuk TypeScript, `unittest` (bawaan Python) untuk `pipeline/`.
- Penyimpanan: file JSON di disk. Tanpa database di v1.

## Konsep data

**1. Library aset.** Global (`public/library/`) dan per brand (`public/brand/<brand>/`), masing-masing dengan subfolder `sfx/`, `musik/`, `font/`, `logo/`, `broll/` dan satu `aset.json`:

```json
{
  "id": "sfx-pop-01",
  "jenis": "sfx",
  "file": "sfx/pop-01.wav",
  "nama": "Pop kecil",
  "tag": ["pop", "teks-muncul"],
  "durasi_detik": 0.18,
  "lisensi": { "sumber": "dibuat sendiri (make-sfx.mjs)", "boleh_iklan_berbayar": true },
  "ditambahkan": "2026-11-12T10:00:00+07:00"
}
```

Aturan: musik tanpa `lisensi.boleh_iklan_berbayar = true` tidak bisa dipilih untuk job berbayar. Aset yang dihapus dipindah ke `_sampah/`, tidak dihapus permanen.

**2. Brand kit** (`brandkit/<brand>.json`, sudah ada untuk Aysilla): nama, handle, logo, warna, font, kosakata Whisper, kamus kata, kata terlarang, CTA per platform, disclaimer.

**3. Preset gaya** (`preset/<brand>-<jenis>.json`): isi bagian C–J form gaya edit dalam bentuk terstruktur, yaitu caption (model, maks kata, kapital, posisi, animasi, gaya kata kunci), durasi per placement, struktur babak, ritme (jeda maksimum, aturan take ulang), efek (status Wajib/Boleh/Jangan per efek, babak, maks per video, jarak minimal), audio (sumber suara, tag SFX per kejadian, musik, volume, target loudness), klaim boleh/dilarang, checklist QC. Preset divalidasi zod. Isian yang saling bertentangan ditolak atau ditandai (contoh di K-2).

**4. Job** (`jobs/<job-id>/`):

```
jobs/AYS-20261112-001/
├─ job.json          status, brief, preset yang dipakai, log, versi
├─ mentah.mp4
├─ transkrip.json
├─ timeline.json     draf/hasil koreksi terakhir (adVideoSchema)
├─ v01/timeline.json, v01/qc.json, v01/<nama-file>.mp4
└─ v02/...
```

Nilai status: `masuk`, `cek_input`, `ditolak`, `transkrip`, `draf`, `menunggu_persetujuan`, `render`, `qc`, `menunggu_penilaian`, `revisi`, `selesai`, `gagal`, `dibatalkan`. Versi lama tidak pernah ditimpa.

## Alur kerja per video

1. **Masuk**: tim upload video, pilih brand + preset + placement, isi brief (produk, harga/promo persis, CTA, catatan).
2. **Cek input**: rasio, durasi, ada suara. Gagal → **Ditolak** dengan alasannya.
3. **Transkrip**: Whisper + kosakata brand, lalu koreksi kamus kata.
4. **Draf**: mesin menyusun `timeline.json` dari preset + brief, plus **ringkasan rencana edit** dalam bahasa biasa (lihat di bawah).
5. **Menunggu persetujuan**: dashboard menampilkan "Rencana edit <jenis> <job> sudah siap. Render ditahan sampai kamu setuju." Tim membaca rencana, mengoreksi kata, potongan, gaya, SFX, dan efek dengan preview langsung, lalu klik **Setujui & render**. **Render tidak pernah jalan otomatis**, termasuk untuk revisi.
6. **Render**: progress % dan perkiraan sisa waktu.
7. **QC otomatis**: checklist bagian J form yang bisa dicek mesin.
8. **Menunggu penilaian**: PIC menonton, memilih **Lulus** atau **Revisi** (catatan dengan acuan detik).
9. **Revisi**: kembali ke langkah 5 dengan timeline versi terakhir dan rencana edit yang diperbarui; render versi baru tetap menunggu persetujuan.

**Isi ringkasan rencana edit** (disimpan di `jobs/<id>/rencana.json`, ditampilkan di atas editor):

- Durasi mentah → perkiraan akhir, dan apakah masih di dalam target preset.
- Bagian yang dibuang (detik + alasan + teks yang hilang).
- Teks hook dan detiknya; kata kunci yang diperbesar.
- Efek yang dipasang (nama, detik, alasan) dan SFX per kejadian; musik (atau "tanpa musik" + alasannya).
- CTA & penutup yang dipakai, disclaimer kalau ada.
- Peringatan yang butuh keputusan: kata terlarang terucap, angka yang tidak ada di brief, durasi lewat batas, aset yang tidak ditemukan.
10. **Selesai**: MP4 final (+ turunan 4:5 dan cover di Fase 3) siap diunduh.

## Spesifikasi layar

Bahasa Indonesia. Bersih, responsif (laptop dan HP lebar 375 px), ada mode gelap.

**1. Beranda**: kartu ringkasan (Menunggu persetujuan, Sedang render, Menunggu penilaian, Selesai hari ini); tabel job (thumbnail, brand, produk, pembuat, status, versi, terakhir diubah); filter brand & status, cari produk, tombol **+ Job baru**.

**2. Job baru**: upload video (drag & drop), brand, preset, placement, brief. Peringatan: "Harga/angka hanya tampil jika ditulis di sini atau diucapkan di video."

**3. Editor job** (layar utama)
- Atas: kartu **Rencana edit** (ringkasan di atas) dengan status "Render ditahan sampai kamu setuju" dan tombol **Setujui & render**. Tombol meminta konfirmasi sekali lagi kalau masih ada peringatan yang belum ditangani.
- Kiri: stepper status + panel log. Tengah: **Remotion Player** 9:16 yang membaca timeline saat ini. Kanan: tab.
- Tab **Transkrip**: kata sebagai chip; kata hasil kamus bergaris bawah; klik untuk edit; centang "simpan ke kamus brand"; sembunyikan kata salah dengar tanpa membuang audionya.
- Tab **Potongan**: daftar potongan (mulai–selesai, jenis, teks yang hilang), centang per baris, ringkasan durasi awal → akhir. Lebih dari durasi maksimum preset → peringatan merah "Pilih bagian tengah yang dibuang; ekor video tidak dipotong."
- Tab **Gaya**: warna, font, posisi caption, maks kata per layar, gaya kata kunci, teks & posisi hook. Perubahan berlaku untuk job ini saja, dengan tombol "Simpan ke preset" (PIC/Owner).
- Tab **Efek & SFX**: efek terpasang (detik, jenis) dan SFX per kejadian; ganti SFX dari library sambil memutar contohnya; tambah/hapus. Batas efek dari preset ditegakkan.
- Tab **Hasil**: progress render, daftar versi, laporan QC per butir, tombol Lulus / Revisi + catatan.
- Fase 2: **Timeline** di bawah Player, berisi track potongan, caption, efek, SFX; geser & trim; tarik SFX dari library ke titik waktu.

**4. Library aset**: grid per jenis (SFX, musik, font, logo, b-roll), filter global/brand dan tag; upload drag & drop; putar audio; contoh font dengan teks bebas; isian lisensi; status "boleh untuk iklan berbayar".

**5. Brand & preset gaya**: brand kit (warna HEX + contoh, font, logo, handle, CTA per platform, kamus kata, kata terlarang, disclaimer); preset per jenis konten dengan bagian sesuai form C–J; validasi dan daftar konflik ditampilkan di atas form.

## Kontrak API lokal

| Method | Path | Fungsi |
| --- | --- | --- |
| GET | /api/jobs | Daftar job + status (filter `brand`, `status`, `q`) |
| POST | /api/jobs | Buat job (upload video + brief), masuk antrean |
| GET | /api/jobs/:id | Detail job, log, versi |
| GET / PUT | /api/jobs/:id/transkrip | Transkrip per kata / simpan koreksi |
| GET / PUT | /api/jobs/:id/timeline | Timeline saat ini / simpan koreksi (validasi `adVideoSchema`) |
| POST | /api/jobs/:id/render | Render timeline saat ini menjadi versi baru |
| GET | /api/jobs/:id/progress | Persentase render + perkiraan sisa |
| POST | /api/jobs/:id/nilai | Lulus atau Revisi + catatan |
| GET | /api/aset | Daftar aset (filter `brand`, `jenis`, `tag`) |
| POST | /api/aset | Upload aset + metadata |
| PUT / DELETE | /api/aset/:id | Ubah metadata / pindahkan ke `_sampah/` |
| GET / PUT | /api/brands/:brand | Brand kit |
| GET / PUT | /api/presets/:id | Preset gaya (validasi + daftar konflik) |

## Aturan bisnis, keamanan & lisensi

**Aturan edit (semua brand)**
- Teks di layar hanya dari ucapan di video atau dari brief. Harga, diskon, stok, angka hanya dari ucapan atau brief.
- Kata terlarang brand tidak pernah tampil sebagai teks. Jika terucap, job diberi peringatan agar PIC memutuskan.
- Ekor video (CTA) tidak boleh terpotong otomatis.
- Render hanya dimulai oleh persetujuan manusia (tombol **Setujui & render** atau `POST /render` dari pengguna). Mesin, antrean, dan Claude API tidak pernah memulai render sendiri.
- Aset hanya dari library (global atau brand job itu). Musik iklan berbayar wajib punya lisensi.
- Versi lama tidak pernah ditimpa. Aset tidak pernah dihapus permanen dari dashboard.

**Keamanan**
- Server hanya mendengarkan jaringan kantor. Dibuka ke luar → wajib login (K-5).
- API key (Claude, ElevenLabs) hanya di `.env`; tidak pernah dikirim ke dashboard atau ditulis ke log.
- Upload dibatasi tipe & ukuran file; nama file dinormalisasi (huruf kecil, tanda hubung) untuk mencegah path traversal.

**Lisensi Remotion**
- Gratis hanya untuk individu, perusahaan for-profit maks 3 karyawan, nonprofit, atau evaluasi. Produksi di perusahaan lebih besar wajib Company License (remotion.pro); syarat untuk aplikasi editor internal perlu dicek (K-4).
- Dashboard hanya untuk pemakaian internal; tidak dijual atau disewakan.

## Di luar scope v1

- Editor CapCut penuh (multi-track bebas, keyframe manual).
- Upload langsung ke TikTok / Meta Ads / Shopee.
- Kontrol edit lewat Telegram.
- Jalur video tanpa bicara dengan VO ElevenLabs, kecuali diputuskan lain di K-3.
- Akses dari luar kantor tanpa login.

## Risiko

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Draf aturan kurang pintar memilih take / hook | Banyak koreksi manual | Editor koreksi cepat; Claude API di Fase 3; log koreksi jadi bahan perbaikan preset |
| Preview Player berbeda dari hasil render | Tim tertipu preview | Player dan render memakai komponen yang sama (`src/AdVideo`); QC membandingkan durasi & frame kunci |
| Render & Whisper berebut PC kantor | Antrean panjang | Satu job diproses sekaligus; render memakai GPU (sudah diatur) |
| Isian preset bertentangan | Hasil tidak konsisten | Validasi zod + daftar konflik di layar preset |
| Lisensi musik tidak jelas | Iklan diturunkan platform | Field lisensi wajib; musik tanpa lisensi tidak bisa dipilih untuk iklan berbayar |

## Keputusan terbuka

Butuh jawaban Owner. Task yang bergantung ditandai di daftar task.

- **K-1 — Claude API key & batas biaya.** Dibutuhkan untuk task 27. Rekomendasi: API key terpisah khusus produksi, batas bulanan di console.
- **K-2 — Konflik isi form Aysilla.** (a) warna dilarang "merah, kuning, biru" vs contoh kata kunci kuning `#F2C14E` di v0.1; (b) durasi TikTok 20 dtk vs struktur babak 0–30 dtk vs brief 30 dtk; (c) ke-17 efek semua "Dipakai" tanpa babak/maks, padahal maks 3 efek per video; (d) "Efek khas brand" berisi tagline, bukan efek; (e) kalimat CTA wajib "Penasaran sama celana anti kusut ini?" vs CTA brief "Join Live, Share"; (f) "Most Grey" atau "Moss Grey". Task 2 tetap jalan dengan nilai dari `brandkit/aysilla.json` dan menandai konflik ini di preset.
- **K-3 — Jalur VO-only (ElevenLabs) untuk Aysilla.** Form menyebut konten Aysilla "tidak bicara, hanya VO". v1 dibangun untuk video dengan suara asli. Perlu diputuskan apakah jalur VO masuk v1.
- **K-4 — Lisensi Remotion.** Kapan membeli Company License, dan apakah lisensinya mencakup editor internal.
- **K-5 — Akses dari luar kantor.** Kalau perlu, login masuk lebih awal dari Fase 3.
- **K-6 — Target volume.** Berapa video per hari per brand; menentukan perlu tidaknya PC render kedua.

## Cara verifikasi (untuk /gasngoding)

Semua perintah dari `D:\VIBECODING\remotion` di PowerShell:

```powershell
npm run lint                                   # eslint src + tsc (sudah ada)
npx vitest run                                 # setelah task 7 menambahkannya
$env:PYTHONIOENCODING="utf-8"
.\.venv\Scripts\python -m unittest discover -s pipeline/tests   # setelah task 1
.\.venv\Scripts\python pipeline\jalan.py C:\Users\distc\Videos\a3.mp4 --brand aysilla --produk celana --draf   # uji mesin end-to-end
```

Video uji `a3.mp4` hanya untuk uji internal, tidak boleh diunggah ke mana pun. Task UI dianggap terverifikasi kalau `npm run lint` dan test komponen lulus, plus dibuka di browser (lebar 1280 px dan 375 px) tanpa error di console.

**Sebelum menjalankan /gasngoding pertama kali:** repo belum punya commit dan masih ada perubahan yang belum di-commit. Commit dulu keadaan sekarang supaya /gasngoding tidak berhenti di preflight.

## Daftar task

Urut dikerjakan. Tiap task: hasil yang diharapkan (DoD) dan ketergantungan. Fase 0 dan 1 tidak menyentuh tampilan.

### Fase 0 — Mesin membaca data, bukan skill

- [ ] **1. Test dasar pipeline.** Tambah `pipeline/tests/` (unittest) untuk `apply_kamus`, `mark_banned`, `plan_captions`, `plan_hook` di `edit.py`, memakai transkrip contoh kecil di `pipeline/tests/data/`.
  DoD: `python -m unittest discover -s pipeline/tests` lulus, minimal 8 test; tidak mengubah perilaku `edit.py`.
- [ ] **2. Skema preset gaya + preset Aysilla.** `src/shared/preset.ts` (zod) untuk bagian C–J form; fungsi `cekKonflik(preset)` mengembalikan daftar konflik. Buat `preset/aysilla-konversi.json`, `aysilla-awareness.json`, `aysilla-branding.json` dari `brandkit/aysilla.json`, form gaya, dan skill `remotion-konversi/awareness/branding`; konflik K-2 dicatat di field `_konflik`.
  DoD: ketiga preset lolos validasi; test `cekKonflik` untuk minimal 4 jenis konflik (warna aksen dilarang, durasi target di luar min–maks, jumlah efek Wajib > maks, babak melewati durasi).
- [ ] **3. Skema job & aset.** `src/shared/job.ts` dan `src/shared/aset.ts` (zod) sesuai bagian Konsep data; status job sebagai enum.
  DoD: test validasi contoh `job.json` dan `aset.json` di PRD (valid) + 3 contoh tidak valid.
- [ ] **4. `edit.py` membaca preset.** Opsi `--preset preset/<id>.json`; maks kata per layar, durasi min/maks, jeda maksimum, posisi caption, gaya kata kunci, font, efek yang diizinkan & batasnya, dan tag SFX diambil dari preset. Opsi CLI lama tetap berlaku sebagai override.
  DoD: test baru untuk pembacaan preset; `jalan.py a3 ... --draf` dengan preset `aysilla-konversi` menghasilkan props valid dan render sukses; tanpa `--preset` perilaku lama tidak berubah (test lama lulus).
- [ ] **5. Font dinamis.** Ubah `styleSchema.titleFont/captionFont` dari enum 3 font menjadi `{ family, src? }`: Google Font berdasarkan nama atau file `.ttf/.otf` dari library. Loader di `src/AdVideo/brand.tsx` menunggu font siap sebelum render (`delayRender`).
  DoD: `npm run lint` lulus; render still frame 45 dengan Google Font lain (mis. Poppins) dan dengan satu file font lokal tampil benar; props lama dengan nama font tetap valid (migrasi).
- [ ] **6. SFX & musik dari library aset.** `plan_sfx` memilih file berdasarkan tag dari preset (mis. `teks-muncul` → aset bertag itu) di `public/brand/<brand>/` lalu `public/library/`; SFX yang ada sekarang (`public/sfx/pop.wav`, `whoosh.wav`) dipindah ke `public/library/sfx/` dengan `aset.json`. Musik hanya yang lisensinya boleh untuk iklan berbayar.
  DoD: test pemilihan SFX (ada di brand, fallback global, tidak ada → tanpa SFX + peringatan); render uji tetap berbunyi SFX.
- [ ] **7. Pipeline per folder job.** `jalan.py --job jobs/<id>` membaca brief & preset dari `job.json`, menulis `transkrip.json`, `timeline.json`, `rencana.json` (ringkasan rencana edit sesuai bagian Alur kerja), status dan log per tahap ke `job.json`, berhenti di `menunggu_persetujuan` dan **tidak merender**. Opsi `--render` merender `timeline.json` ke `vNN/` berikutnya tanpa menimpa versi lama. Tambah `vitest` + script `npm test`.
  DoD: test untuk penomoran versi, transisi status, isi `rencana.json` (semua butir ringkasan ada), dan bahwa tanpa `--render` tidak ada file video yang dibuat; uji `a3` lewat `--job` sampai `menunggu_persetujuan` lalu `--render` dua kali menghasilkan `v01` dan `v02`.

### Fase 1 — Server lokal

- [ ] **8. Kerangka server.** `server/` (Express, TypeScript), script `npm run server`, port dari `.env` (`PORT`, default 3210), hanya mendengarkan alamat jaringan lokal; `GET /api/sehat`. Upload dibatasi tipe & ukuran.
  DoD: test `GET /api/sehat`; server jalan dan berhenti bersih.
- [ ] **9. API job.** `GET/POST /api/jobs`, `GET /api/jobs/:id` sesuai kontrak; ID format `<KODE>-<YYYYMMDD>-<NNN>`; video disimpan ke `jobs/<id>/mentah.mp4`.
  DoD: test buat job (upload file kecil), daftar dengan filter, detail, 404, dan penolakan file bukan video.
- [ ] **10. Antrean & runner.** Satu job diproses sekaligus; runner memanggil `jalan.py --job` sebagai proses anak, membaca status dari `job.json`, menangani gagal (status `gagal` + pesan, bisa dicoba ulang). Runner hanya menjalankan tahap sampai draf; render hanya lewat task 12.
  DoD: test antrean (urutan, satu sekaligus, gagal tidak menghentikan antrean, runner tidak pernah memicu render) dengan runner palsu; uji nyata satu job sampai `menunggu_persetujuan`.
- [ ] **11. API transkrip & timeline.** `GET/PUT /api/jobs/:id/transkrip` dan `/timeline` dengan validasi zod; koreksi kata bisa ditandai "simpan ke kamus brand" dan ditulis ke `brandkit/<brand>.json`.
  DoD: test simpan valid, tolak tidak valid, dan penulisan kamus tanpa merusak isi brand kit lainnya.
- [ ] **12. API render & penilaian.** `POST /render` (via `@remotion/renderer`, satu render sekaligus; ditolak kecuali status `menunggu_persetujuan` dan permintaan membawa `setuju: true`), `GET /progress` (persen + perkiraan sisa), `POST /nilai` (Lulus → `selesai`; Revisi → `revisi` + catatan).
  DoD: test transisi status & versi, dan penolakan render tanpa persetujuan; uji nyata render `v01` dengan progress yang naik sampai 100.
- [ ] **13. QC otomatis.** Setelah render, tulis `vNN/qc.json` untuk butir checklist J yang bisa dicek mesin: durasi, rasio & resolusi, hook di 3 detik pertama, ejaan sesuai kamus, angka hanya dari brief/ucapan, kata terlarang, logo/handle ada, jumlah efek ≤ batas, nama file.
  DoD: test per butir (lulus dan gagal); QC jalan otomatis di uji render.
- [ ] **14. API aset.** `GET/POST /api/aset`, `PUT/DELETE /api/aset/:id`; upload menulis file + `aset.json`; DELETE memindahkan ke `_sampah/`; durasi audio dibaca otomatis.
  DoD: test upload, filter tag, ubah metadata, hapus ke `_sampah/`, tolak nama file berbahaya (`../`).
- [ ] **15. API brand & preset.** `GET/PUT /api/brands/:brand` dan `/api/presets/:id` dengan validasi; respons PUT preset menyertakan daftar konflik.
  DoD: test simpan, tolak tidak valid, konflik terlaporkan.

### Fase 2 — Dashboard (L1)

- [ ] **16. Kerangka dashboard.** `dashboard/` (Vite + React + TS), script `npm run dashboard`, proxy `/api` ke server, layout responsif + mode gelap, navigasi Beranda / Library aset / Brand & preset. Satu modul `api.ts` untuk semua panggilan.
  DoD: lint lulus; terbuka di 1280 px dan 375 px tanpa error console.
- [ ] **17. Beranda.** Kartu ringkasan, tabel job, filter brand & status, cari, klik baris ke editor; refresh berkala status.
  DoD: test komponen filter/cari; diuji dengan job nyata.
- [ ] **18. Job baru.** Form upload + brand + preset + placement + brief, CTA terisi dari brand kit, peringatan angka, progress upload.
  DoD: test validasi form; membuat job nyata yang masuk antrean.
- [ ] **19. Editor: kartu Rencana edit + Player + stepper + log.** Kartu Rencana edit di atas editor dengan pesan "Rencana edit <jenis> <job> sudah siap. Render ditahan sampai kamu setuju." dan tombol **Setujui & render** (konfirmasi tambahan kalau masih ada peringatan). Remotion Player memutar `timeline.json` job dengan komposisi `src/AdVideo` yang sama dengan render; stepper status; panel log.
  DoD: kartu menampilkan semua butir `rencana.json`; render tidak mulai sebelum tombol ditekan; preview job uji sama dengan frame hasil render di 3 titik (cek visual); lint lulus.
- [ ] **20. Editor: tab Transkrip.** Chip kata, garis bawah hasil kamus, edit kata, sembunyikan kata, "simpan ke kamus brand"; Player langsung memperbarui caption.
  DoD: test komponen; edit tersimpan via API dan bertahan setelah reload.
- [ ] **21. Editor: tab Potongan.** Centang per potongan, ringkasan durasi, peringatan durasi maksimum, ekor tidak bisa dibatalkan; Player langsung memperbarui.
  DoD: test hitung durasi & aturan ekor; tersimpan via API.
- [ ] **22. Editor: tab Gaya.** Kontrol warna, font (dari library + Google Fonts), posisi caption, maks kata, gaya kata kunci, teks & posisi hook; "Simpan ke preset" untuk PIC/Owner.
  DoD: perubahan terlihat di Player < 1 detik; test kontrol; simpan job vs simpan preset terbukti terpisah.
- [ ] **23. Editor: tab Efek & SFX.** Daftar efek & SFX per waktu, ganti SFX dari library dengan putar contoh, tambah/hapus, batas preset ditegakkan.
  DoD: test batas efek; perubahan terdengar di Player.
- [ ] **24. Editor: tab Hasil.** Progress render, daftar versi + unduh, laporan QC, Lulus / Revisi + catatan dengan acuan detik.
  DoD: alur koreksi → render → Revisi → render → Lulus diuji dengan job nyata (v01, v02).
- [ ] **25. Library aset.** Grid per jenis, filter brand/global & tag, upload drag & drop, putar audio, contoh font, isian lisensi.
  DoD: test filter; upload SFX baru lalu dipakai di editor job.
- [ ] **26. Brand & preset gaya.** Form brand kit + preset (bagian C–J) dengan validasi dan daftar konflik di atas form.
  DoD: ubah font caption di preset → job baru memakai font itu; konflik K-2 terlihat di preset Aysilla.

### Fase 3 — Timeline, AI, dan pelengkap

- [ ] **27. Keputusan AI via Claude API.** Modul di `pipeline/` yang mengirim transkrip + preset + brief ke Claude API dan mengembalikan usulan take ulang yang dibuang, teks hook, kata kunci, dan penempatan efek dalam JSON tervalidasi; fallback ke aturan kalau API gagal; biaya per job dicatat di `job.json`. **Bergantung K-1.**
  DoD: test dengan respons API palsu (valid, tidak valid, timeout); uji nyata pada 3 video setelah K-1 dijawab.
- [ ] **28. Timeline ringan (L2).** Track potongan, caption, efek, SFX di bawah Player; geser & trim; tarik SFX dari library ke titik waktu; zoom timeline.
  DoD: test konversi posisi ↔ waktu; perubahan di timeline sama dengan di tab lain.
- [ ] **29. Versi turunan.** Render otomatis 4:5 (1080×1350) dan cover/thumbnail dari master 9:16 sesuai preset.
  DoD: file turunan ada di folder versi dengan resolusi benar; QC rasio lulus.
- [ ] **30. Login & peran.** Login sederhana, peran Owner / PIC / Tim konten, akses per brand sesuai tabel peran. **Bergantung K-5** untuk prioritas.
  DoD: test otorisasi per endpoint (PIC brand A tidak bisa mengubah preset brand B).

### Nanti (bukan task v1)

- Notifikasi Telegram satu arah (status job + link ke dashboard).
- Jalur video tanpa bicara dengan VO ElevenLabs (K-3).
- Ringkasan biaya & waktu per brand.
