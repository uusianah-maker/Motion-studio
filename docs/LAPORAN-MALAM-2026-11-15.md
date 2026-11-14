# Laporan kerja malam — 15 Nov 2026 (venus-malam)

**Singkatnya: semua 7 fitur pilihan owner dari audit CapCut sudah jadi, sudah dites, dan sudah online di motionproject.online.**

Yang dikerjakan: fade suara + ducking musik, reduksi noise, latar blur untuk video bukan 9:16, adjust warna, filter warna buatan sendiri (+ filter bawaan per brand), transisi, dan keyframe. Halaman **Hasil** (dikerjakan venus) tidak diubah dan audit-nya tetap lulus.

Semua dibuat sendiri dengan FFmpeg. Yang ditiru dari CapCut hanya tekniknya. Tidak ada file, filter, LUT, sticker, font, atau nama preset milik CapCut/ByteDance.

---

## ✅ Yang sudah jadi & cara pakainya

Semua kontrol ada di **Editor → klik klip di linimasa → panel Inspector** (kanan). Setiap perubahan bisa di-**Undo/Redo** (satu perubahan = satu langkah undo, termasuk geser slider).

### 1. Fade suara + ducking musik
- **Fade:** klik klip video/audio/musik/SFX → isi **Fade masuk (dtk)** dan/atau **Fade keluar (dtk)**, misalnya `0,5` → Enter. Suara naik/turun pelan di awal/akhir klip.
- **Ducking:** klik klip di track **Musik** → centang **"Ducking: musik turun saat ada suara bicara"** → atur **Musik saat bicara** (bawaan 30%). Musik otomatis turun saat ada voice-over (track Audio) atau suara dari video utama, lalu naik lagi saat jeda.
- Pratinjau ikut terdengar (fade dan ducking).

### 2. Reduksi noise suara
- Klik klip yang ada suaranya → **Reduksi noise**: Mati / Ringan / Sedang.
- Hanya terdengar di **hasil render**. Pratinjau browser tetap memutar suara asli.

### 3. Latar blur untuk video bukan 9:16
- Klik klip video/b-roll → **Di canvas**:
  - **Pas + latar hitam** (seperti sebelumnya),
  - **Pas + latar blur** (salinan video yang diburamkan mengisi bagian kosong, seperti CapCut),
  - **Pas + latar warna** (pilih warnanya),
  - **Isi layar (crop)** (video dipotong supaya penuh).

### 4. Adjust
- Klik klip video/b-roll → slider **Terang, Kontras, Saturasi, Suhu warna, Ketajaman, Vignette**. Tombol **Reset adjust** mengembalikan ke normal.
- Ketajaman hanya terlihat di hasil render. Warna lain di pratinjau **mendekati** hasil render.

### 5. Filter warna (8 buatan sendiri)
- Klik klip video/b-roll → **Filter warna**: Hangat, Sejuk, Cerah Natural, Pastel, Kontras Tegas, Hitam Putih, Senja Keemasan, Adem Lembut. Ada juga "Tanpa filter" dan "Ikuti brand".
- **Filter bawaan per brand:** menu **Brand** → bagian B (Visual) → **Filter bawaan video** → Simpan Brand Kit. Semua klip video/b-roll proyek brand itu otomatis memakai filter tersebut, kecuali klip yang memilih filter sendiri.

### 6. Transisi di titik potong
- Klik klip video/b-roll yang **sesudah** titik potong → **Transisi masuk**: Dissolve, Geser ke kiri, Geser ke kanan, Wipe, Flash putih, atau Zoom-through (memakai efek zoom yang sudah ada).
- Atur **Durasi transisi (ms)** 200–1500.
- **Durasi video tidak berubah** dan suara tetap sinkron (suara tetap potong biasa).
- Pratinjau menampilkan **perkiraan** transisi. Hasil persisnya terlihat setelah render.

### 7. Keyframe (posisi, skala, opasitas)
- Klik klip video, b-roll, atau teks → bagian **Keyframe (gerak)**:
  - **Gerak cepat…** untuk sekali klik: *Zoom pelan (Ken Burns)*, *Muncul & hilang pelan*, *Masuk dari bawah*;
  - atau taruh playhead di dalam klip → **＋ Keyframe di playhead**, lalu atur **X %, Y %, Skala %, Opasitas %** dan **Gerak** (Halus / Rata) tiap titik.
- Pratinjau dan render bergerak dengan kurva yang sama.

---

## ⏳ Yang belum / batasan
- **Keyframe di teks** belum bisa digabung dengan caption kata-per-kata, animasi Pop/Fade, atau sorot kata. Kalau dicoba, aplikasi menolak dengan pesan jelas. Alasannya: caption jenis itu digambar dengan mesin teks lain (libass), jadi perlu pekerjaan tambahan.
- **Transisi** hanya dipasang di **awal klip** (klip sesudah titik potong). Video yang "lanjut lagi" setelah b-roll selesai belum bisa diberi transisi keluar dari b-roll.
- **Pratinjau** transisi, ketajaman, dan reduksi noise hanya perkiraan. Hasil render yang jadi patokan.
- **Mesin** (Generate Otomatis / Batch Remix) belum memakai fitur baru ini. Field-nya sudah dicatat di kontrak (`KONTRAK-ENGINE.md` bagian 12) sebagai **opsional**, jadi mesin tidak wajib berubah.

---

## 🧪 Hasil tes
| Tes | Hasil |
|---|---|
| `npm run verify` (build, typecheck, lint, semua tes, smoke) | ✅ hijau: core 303 lulus (1 dilewati, sudah begitu sebelumnya), server 113, web 17, smoke OK |
| Tes fitur malam ini (`packages/core/test/m15-capcut-fitur.test.ts`) | ✅ 11/11, termasuk **4 render FFmpeg nyata**: fade + ducking + reduksi noise diukur dari suara hasil render; latar isi/blur/warna, hitam putih, suhu, terang dicek dari piksel; transisi dissolve & flash di titik potong dengan durasi tetap 3,0 dtk; keyframe video (mengecil, bergeser, memudar) dan teks (muncul pelan) |
| Audit Chrome baru `audit/M15/ui.mjs` (masuk `npm run test:ui`) | ✅ 28/28: semua kontrol Inspector tersimpan, pratinjau ikut berubah, undo/redo, Brand Kit filter bawaan, **render nyata dari aplikasi** (latar blur + hitam putih + filter brand + durasi 4 dtk + metadata bersih), tampilan HP 390 px tanpa geser samping, 0 error JS |
| Audit Chrome lama yang terkait editor/render | ✅ Editor W06 16/16, Pratinjau W07 19/19, Render W08 17/17, Inspector X02 11/11, Audio X04 12/12, Brand Kit X06 13/13, Zoom/crop/blur U3 21/21, **Hasil 10/10** |
| `npm run check:deploy -- --url https://motionproject.online` | ✅ semua OK setelah server di-restart |

---

## 🔖 Commit
Repo `Motion-studio`, branch `main`, sudah di-push (fast-forward, tanpa merge):
- `f7ca7d5`: Inti (validasi + render FFmpeg): fade, ducking, reduksi noise, latar blur/isi/warna, adjust, filter warna, transisi
- `595e8c4`: Editor: kontrol di Inspector + Filter bawaan di Brand Kit + audit Chrome M15
- `3c16dc4`: Keyframe posisi/skala/opacity (inti + render + editor + tes)
- laporan ini: commit terakhir malam ini

Repo mesin `remotion` (lokal, hanya dokumen kontrak): `7a734a7`, `cb9e9f5`.

Fitur 1–6 berbagi satu modul inti (`clipLook.ts`) dan satu panel Inspector. Karena itu commit-nya dibagi per lapisan (inti / editor), bukan per fitur. Keyframe punya commit sendiri.

---

## ⚠️ Catatan risiko
- **Render lebih berat** bila memakai keyframe skala (ukuran gambar dihitung ulang tiap frame), latar blur, atau reduksi noise. Untuk video iklan pendek (< 60 dtk) masih wajar.
- **Kontrak mesin** diperbarui di repo `remotion` (commit lokal `7a734a7`, `cb9e9f5`, hanya file `docs/KONTRAK-ENGINE.md`). Salinan di `engine/` Motion-studio **belum** disinkronkan. Itu tugas sync subtree rutin venus. Folder `pipeline/` tidak disentuh.
- **File milik sesi lain tidak disentuh dan tidak di-commit:** `docs/TUTORIAL-BATCH-REMIX.*`, bukti audit lama (`audit/*/evidence` yang berubah karena tes), `audit/A14`, `audit/HASIL/evidence`, `audit/U8/evidence/batch-rusak.png`.
- **Server online** sudah di-restart ke build baru. Sebelum restart dicek dulu tidak ada render/job yang sedang jalan. Sesi login tim tersimpan di disk, jadi tidak ada yang ter-logout.
- **Panduan editor** belum ditambah bab khusus fitur baru. Laporan ini bisa dipakai sukma sebagai bahan.
