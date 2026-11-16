# R23/R24 — lisensi alat AI lokal, kapasitas PC, dan rencana uji QA (16 Nov 2026, sukma)

Disiapkan untuk mendukung R23 (ucok: alat edit di Editor) dan R24 (yuki: AI lokal di mesin).
**Belum ada yang dipasang atau diunduh.** Semua `pip install` dan unduhan model menunggu OK venus.

## 1. Lisensi: boleh dipakai bisnis?

Sumbernya adalah file LICENSE di repo asli dan kartu model resmi, dicek 16 Nov 2026.

| Alat | Lisensi kode | Bobot model yang dipakai | Bisnis? |
|---|---|---|---|
| **BiRefNet** (ZhengPeng7/BiRefNet) | MIT, © 2024 ZhengPeng | MIT, menurut kartu HF `ZhengPeng7/BiRefNet`. Dilatih dengan DIS5K. | **Boleh** |
| **rembg** (danielgatis/rembg) | MIT, © 2020 Daniel Gatis | Tiap model punya lisensinya sendiri, lihat catatan di bawah tabel | **Boleh, dengan syarat model dipilih eksplisit** |
| ↳ `u2net`, `u2netp`, `u2net_human_seg`, `silueta` | — | Apache-2.0 (xuebinqin/U-2-Net) | Boleh |
| ↳ `isnet-general-use` | — | Apache-2.0 (xuebinqin/DIS) | Boleh |
| ↳ `birefnet-*` | — | MIT (BiRefNet) | Boleh |
| ↳ **`bria-rmbg`** (RMBG-1.4 / 2.0) | — | **CC BY-NC 4.0 / lisensi BRIA.** Pakai komersial wajib kontrak berbayar dengan BRIA. | **TIDAK** |
| ↳ `withoutbg`, `atlascloud` | — | Bukan model lokal. Gambar dikirim ke server pihak luar. | **TIDAK** (footage keluar PC) |
| **Real-ESRGAN-ncnn-vulkan** (xinntao) | MIT, © 2021 Xintao Wang dan © 2019 nihui (realsr-ncnn) | BSD-3-Clause (xinntao/Real-ESRGAN, © 2021 Xintao Wang) | **Boleh** |
| **MediaPipe** (google-ai-edge/mediapipe) | Apache-2.0 | BlazeFace (face detector) berlisensi Apache-2.0 menurut kartu model Google. EfficientDet-Lite / SSD MobileNetV2 (object detector) dilatih dengan COCO; halaman Google tidak menyebut lisensi terpisah, dan model asalnya dari TF Model Garden (Apache-2.0). | **Boleh** |
| **AutoFlip** (bagian MediaPipe) | Apache-2.0 | Memakai detektor MediaPipe di atas | Lisensinya boleh, **tapi jangan dipakai.** Alasannya di bawah tabel. |

**Catatan penting:**
1. **rembg: model `bria-rmbg` disebut model bawaan di README rembg sekarang.**
   - Kode R23/R24 harus selalu menyebut model secara eksplisit, misalnya `new_session("birefnet-general-lite")` atau `isnet-general-use`.
   - Jangan pernah memanggil rembg tanpa nama model.
   - Sebaiknya tambahkan daftar putih model di kode: `u2net*`, `isnet-general-use`, `birefnet-*`, `silueta`. Model lain ditolak.
2. **AutoFlip tidak direkomendasikan.**
   - Google menghentikan dukungan semua *MediaPipe Legacy Solutions* per 1 Maret 2023, termasuk AutoFlip.
   - AutoFlip tidak ada di paket pip. Ia harus dibangun dengan Bazel, dan praktis hanya jalan di Linux/macOS.
   - Penggantinya yang lebih ringan: BlazeFace / Object Detector (MediaPipe Tasks, pip, didukung) untuk mencari subjek, lalu crop 9:16 dengan penghalusan gerak di kode kita sendiri. Ini sama dengan inti AutoFlip.
3. **Kewajiban atribusi.**
   - MIT, BSD-3, dan Apache-2.0 hanya mewajibkan teks lisensi dan copyright ikut disertakan kalau kodenya didistribusikan.
   - Dipakai di server sendiri bukan distribusi, tapi catat tetap disarankan.
   - Usul: file `THIRD_PARTY_NOTICES.md` di repo untuk alat yang benar-benar dipasang.
4. **Data latih.**
   - DIS5K, DF2K/OST (Real-ESRGAN), dan COCO adalah set data riset.
   - Lisensi bobot dari pembuatnya (MIT / BSD-3 / Apache-2.0) tidak membatasi pemakaian komersial.
   - Risiko sisa rendah, dan sama dengan ribuan aplikasi komersial yang memakai model-model ini.
   - Ini bukan nasihat hukum. Kalau owner mau kepastian penuh, pakai hanya yang kodenya milik Google (MediaPipe) dan BiRefNet.

## 2. Kapasitas PC kantor (diukur 16 Nov 2026)

| Bagian | Hasil ukur |
|---|---|
| GPU | NVIDIA GeForce **GTX 1650, VRAM 4 GB** (4096 MiB); driver 592.82; Vulkan 1.4 tersedia. Saat diam terpakai ±0,5 GB oleh desktop dan aplikasi. Kartu ini tidak punya tensor core: fp16 menghemat memori tapi tidak banyak menambah kecepatan. |
| Pemakai GPU sekarang | Whisper `large-v3-turbo` lewat faster-whisper/CTranslate2 CUDA, `int8_float16`, kira-kira 1–1,5 GB VRAM saat transkrip. |
| CPU | Intel i5-12500H: 12 core, 16 thread |
| RAM | **23,7 GB total, hanya 4,8 GB bebas saat diukur** (Chrome, CapCut, beberapa sesi Claude, WPS). Pagefile 21 GB di C:. |
| Disk C: | **Sisa 30 GB.** Cache model HuggingFace sudah ada di `C:\Users\distc\.cache\huggingface` (1,9 GB, Whisper). |
| Disk D: | Sisa 1,38 TB. SSD USB exFAT, **tanpa backup** (R15). Model bisa diunduh ulang, jadi aman ditaruh di sini. |
| Python mesin | `.venv` Python 3.12.5, numpy 2.5.4, onnxruntime 1.31.1 **CPU saja** (tidak ada provider CUDA/DirectML), opencv-headless 4.14 |

### Perkiraan kebutuhan per alat

Ini perkiraan, belum diukur, karena belum boleh memasang apa pun. Angka pasti diukur saat uji pertama.

| Alat | Ukuran model di disk | Jalan di | Memori | Kecepatan di PC ini (perkiraan) | Cocok untuk |
|---|---|---|---|---|---|
| rembg `birefnet-general` | ±970 MB | CPU (onnxruntime yang ada) | RAM 2–3 GB | ±3–10 detik per gambar 1024² | foto produk / thumbnail satuan |
| rembg `birefnet-general-lite` / `isnet-general-use` / `u2net` | ±170–230 MB | CPU | RAM 1–1,5 GB | ±0,5–2 detik per gambar | gambar satuan; video hanya untuk klip pendek atau keyframe |
| BiRefNet PyTorch CUDA fp16 | ±450 MB plus torch ±2,5 GB | GPU | **VRAM 2–3,5 GB**, tidak muat bersama Whisper | ±0,3–1 detik per frame | hapus latar video. **Butuh torch, paket berat. Jangan dulu.** |
| Real-ESRGAN-ncnn-vulkan | ±50 MB (exe plus 4 model) | GPU Vulkan | VRAM 0,5–1,5 GB (atur `-t 128/256`) | ±1–3 detik per frame 720p; 30 detik video @30fps ≈ 15–45 menit | upscale b-roll resolusi rendah saja, bukan footage 1080p |
| MediaPipe Tasks (face/object) | wheel ±40–60 MB, model 1–10 MB | CPU | RAM <0,5 GB | beberapa ms per frame | deteksi wajah/subjek, crop otomatis 9:16 |

**Risiko pemasangan (untuk yuki/venus):**
- **mediapipe dan numpy 2.**
  - Versi mediapipe di pip sering mengunci `numpy<2`, sedangkan `.venv` mesin memakai numpy 2.5.4.
  - Memasangnya ke `.venv` bisa menurunkan numpy dan merusak mesin yang live, karena `.venv` dipakai bersama oleh rilis mesin.
  - Usul: venv terpisah (seperti `demucs-venv`), misalnya `ai-venv`, yang dipanggil mesin sebagai proses anak.
  - Atau cek dulu dengan `pip install --dry-run` di salinan venv sebelum menyentuh `.venv`.
- **Cache model jangan di C:.**
  - Bawaan rembg adalah `~/.u2net` dan HuggingFace `~/.cache` (C:, sisa 30 GB).
  - Set `U2NET_HOME` dan `HF_HOME` ke folder di D:, misalnya `D:\VIBECODING\remotion\models\`, lewat env proses mesin.
- **onnxruntime-gpu** (supaya rembg pakai GPU) butuh CUDA 12 dan cuDNN 9, dan menggantikan `onnxruntime` yang sekarang. Jangan dulu: CPU sudah cukup untuk gambar satuan.

### Dampak ke situs live dan usulan batas
Server Node sendiri tidak memakai GPU. Ia terganggu kalau CPU penuh (PC-R3) atau RAM habis sehingga Windows menukar memori ke disk. Usulan aturan untuk R24:

1. **Satu job AI berat sekaligus**, termasuk Whisper.
   - Kunci global yang sama untuk transkrip, hapus latar, dan upscale.
   - GPU 4 GB tidak muat dua model besar. Kalau dua jalan bersamaan, job kedua gagal kehabisan memori, atau keduanya melambat.
2. **Prioritas Idle**, sama dengan aturan job berat sekarang. Batasi thread CPU: `OMP_NUM_THREADS=4`, onnxruntime `intra_op_num_threads=4`, maksimal 2 pekerja.
3. **Batas RAM.**
   - Sebelum mulai, job memeriksa RAM bebas lebih dari 3 GB. Kalau kurang, job menunggu di antrean, bukan langsung jalan.
   - Saat diukur, RAM bebas hanya 4,8 GB karena aplikasi desktop owner.
4. **Upscale/hapus latar video wajib dipotong.**
   - Batas panjang, misalnya maksimal 15 detik per klip, atau hanya bagian yang dipilih.
   - Perkiraan waktu ditampilkan sebelum mulai, sesuai aturan "konfirmasi sebelum render".
5. **Model di D:** lewat `U2NET_HOME`/`HF_HOME`. Total semua model di atas di bawah 3 GB.
6. **Jangan pakai bria-rmbg dan model cloud**, ditegakkan dengan daftar putih model di kode (bagian 1).

## 3. Rencana uji QA ringan untuk R23 (dijalankan saat ucok/venus memberi tanda)
Uji berjalan di server uji (port 4397/4398, workspace sementara), **bukan** di 4317. Footage yang dipakai adalah klip uji buatan sendiri, atau klip yang sudah boleh dipakai.

Untuk **tiap alat edit R23** yang dilaporkan siap:

| # | Uji | Cara | Lulus kalau |
|---|---|---|---|
| Q1 | Preview = render | Pasang alat di Editor, ambil tangkapan layar preview di 3 titik waktu (awal, tengah, akhir efek). Render, lalu ambil frame di titik yang sama dengan `ffmpeg -ss t -frames:v 1`. Bandingkan berdampingan; kalau perlu, ukur SSIM dengan ffmpeg `ssim`. | posisi, ukuran, warna, dan waktu sama (SSIM ≥ 0,9 untuk area alat); tidak ada offset ±1 frame |
| Q2 | Undo/redo | Terapkan alat, ubah parameter 3 kali, undo 3 kali, lalu redo 3 kali. Muat ulang halaman. | tiap undo kembali tepat ke langkah sebelumnya; setelah dimuat ulang, keadaan tersimpan sama dengan yang terakhir terlihat |
| Q3 | Ponsel | Viewport 375×812 (preset mobile) dan 768 (tablet): buka Editor, pakai alat dengan sentuhan/klik, cek tidak ada scroll horizontal dan tombol tidak tertutup. | alat bisa dipakai penuh di 375 px |
| Q4 | Batas dan salah input | Nilai ekstrem (0, maksimum, kosong), klip sangat pendek (<1 detik), klip panjang | tidak crash, pesan jelas dalam Bahasa Indonesia |
| Q5 | Tidak menimpa | Teks/caption yang sudah ada tidak tertimpa (keputusan owner G2); file asli tidak berubah | file sumber hash-nya sama sebelum dan sesudah |
| Q6 | Beban | Kalau alat memakai AI (R24): jalankan sambil memantau `/api/health` tiap 2 detik dan prioritas proses | waktu jawab situs tetap < 1 detik; proses AI berprioritas Idle; satu job sekaligus |

Laporan per bagian ke venus berisi: lulus/gagal, tangkapan layar preview vs frame render, dan langkah reproduksi kalau gagal.

## Sumber
- BiRefNet: https://github.com/ZhengPeng7/BiRefNet (LICENSE), https://huggingface.co/ZhengPeng7/BiRefNet
- rembg: https://github.com/danielgatis/rembg (LICENSE.txt, daftar model di README)
- U-2-Net: https://github.com/xuebinqin/U-2-Net (LICENSE); DIS/IS-Net: https://github.com/xuebinqin/DIS (LICENSE.md)
- BRIA RMBG: https://huggingface.co/briaai/RMBG-1.4, https://huggingface.co/briaai/RMBG-2.0
- Real-ESRGAN-ncnn-vulkan: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan (LICENSE); Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN (LICENSE)
- MediaPipe: https://github.com/google-ai-edge/mediapipe (LICENSE); Face Detector: https://developers.google.com/edge/mediapipe/solutions/vision/face_detector (kartu model BlazeFace, Apache-2.0); Object Detector: https://developers.google.com/edge/mediapipe/solutions/vision/object_detector
- Status legacy AutoFlip: https://developers.google.com/edge/mediapipe/solutions/guide
