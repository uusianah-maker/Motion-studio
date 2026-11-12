# Pembagian kerja: venus · yuki · ucok

Versi: 13 November 2026 · status: **usulan, menunggu persetujuan owner**

## Keputusan yang mendasari

1. **Satu aplikasi: Motion Studio** (`D:\VIBECODING\Video motion`). Menu: Generate Otomatis, Batch Remix, Editor (finishing).
2. **Tanpa Remotion.** Owner tidak membeli lisensi. Semua render memakai **FFmpeg** yang sudah dipakai Motion Studio. Efek yang selama ini dari Remotion (caption per kata, kata kunci, judul kaca, zoom, penutup) dibangun ulang dengan FFmpeg + libass.
3. **Satu renderer.** Mesin otomatis tidak merender sendiri. Mesin hanya menyusun **rencana edit** dalam format proyek Motion Studio, lalu Motion Studio yang merender. Hasilnya: pratinjau = render, dan editor bisa langsung finishing di timeline yang sama.
4. **Brand Kit per brand** di Motion Studio, isinya mengikuti `docs/BRAND-KIT-LENGKAP.md`.
5. **Semua serba otomatis**, tapi render tetap menunggu persetujuan rencana edit.

## Aturan main

- **venus dan yuki** hanya mengubah file di `D:\VIBECODING\remotion`.
- **ucok** hanya mengubah file di `D:\VIBECODING\Video motion`.
- Penghubungnya satu **kontrak data** (`docs/KONTRAK-ENGINE.md`, disusun venus, direviu ucok). Perubahan kontrak harus disepakati kedua pihak.
- Di repo remotion: **venus** memegang mesin inti + Generate Otomatis, **yuki** memegang modul Batch Remix. Dua sesi tidak mengubah file yang sama (`pipeline/edit.py` milik venus; yuki memanggilnya, tidak mengubahnya).

## venus — mesin Generate Otomatis (`remotion/`)

| # | Pekerjaan | Hasil |
| --- | --- | --- |
| V1 | **Kontrak data** (draf): input job (video, brief, Brand Kit hasil ekspor) → output `rencana.json` (ringkasan untuk disetujui) + `ops.json` (operasi timeline Motion Studio) + `qc.json` | `docs/KONTRAK-ENGINE.md` |
| V2 | **Pembaca Brand Kit multi-brand** dari ekspor Motion Studio; `brandkit/aysilla.json` dimigrasi jadi data awal brand Aysilla | Mesin tidak lagi punya Brand Kit sendiri |
| V3 | **Generate Otomatis keluar sebagai `ops.json`**, bukan render Remotion | Draf terbuka langsung di Motion Studio |
| V4 | **Perbaikan dari uji 13 Nov**: deteksi video tanpa ucapan / halusinasi Whisper, posisi caption aman (hindari wajah & produk), pemilihan hook yang tidak kepotong, daftar superlatif lebih lengkap | Draf lebih jarang perlu dikoreksi |
| V5 | **CLI tunggal** untuk dipanggil Motion Studio, dengan progres per tahap (JSON per baris) | Satu perintah, mudah dipantau |
| V6 | **Lepas Remotion** dari repo setelah V3 jalan (`src/AdVideo`, paket `remotion`) | Tidak ada ketergantungan lisensi |

## yuki — modul Batch Remix (`remotion/`)

| # | Pekerjaan | Hasil |
| --- | --- | --- |
| Y1 | Pisah Audio + Stem Splitter (`pipeline/pisah.py`, folder `konten/`) | Sudah ada |
| Y2 | Shot Library: potong per shot + label (close-up, full body, demo, wajah bicara, teks bawaan, watermark) | Daftar shot per footage |
| Y3 | Matcher: kalimat VO → shot relevan, hindari lip-sync dari kreator lain | Susunan shot per VO |
| Y4 | Music Matcher: musik berlisensi sesuai mood/tempo, potongan ikut ketukan | Musik per varian |
| Y5 | Perencana batch: N kombinasi unik → banyak `rencana.json` + `ops.json` (format kontrak V1) | Tabel rencana untuk disetujui sekali |

## ucok — aplikasi Motion Studio (`Video motion/`)

| # | Pekerjaan | Hasil |
| --- | --- | --- |
| U1 | **Brand Kit multi-brand** (sekarang satu per workspace) + semua isian A–F di `BRAND-KIT-LENGKAP.md` + ekspor JSON untuk mesin | Pilih brand per proyek |
| U2 | **Library aset per brand** dengan tag & status lisensi (SFX, musik, b-roll, logo, penutup) | Mesin bisa memilih aset dari tag |
| U3 | **Fitur render pengganti Remotion** (FFmpeg + libass): caption per kata dengan animasi pop & sorot kata kunci, judul kotak kaca (blur), digital zoom / punch-in, transisi zoom-through, penutup logo/video, disclaimer, loudness −14 LUFS | Hasil otomatis setara uji Remotion, pratinjau = render |
| U4 | **Halaman Generate Otomatis**: upload + brief → panggil CLI mesin → kartu rencana edit (render ditahan) → koreksi cepat → setujui → antrean render → QC → Lulus / Revisi → buka di Editor untuk finishing | Alur harian tim |
| U5 | **Halaman Batch Remix**: input N video → tabel rencana → coret / setujui sekali → antrean render | Produksi massal |
| U6 | **Runner job**: memanggil CLI mesin, menyimpan hasil ke proyek, menampilkan progres | Penghubung UI ↔ mesin |
| U7 | **Peran & persetujuan** (X10): Owner / Editor / Reviewer | Sesuai rencana v3.0 |

X09 (Varian) yang sudah selesai tetap dipakai untuk varian sederhana dari satu proyek (rasio / hook / CTA). Batch Remix untuk remix banyak footage.

## Urutan

1. **Mulai bersamaan:** V1 (kontrak) dan U1 (Brand Kit multi-brand). Kontrak direviu ucok sebelum dikunci.
2. **Paralel:** V2–V4 dan U2–U3.
3. **Sambung:** U4 + U6 memakai V3 + V5. Uji ulang dengan rekaman asli → gerbang 1.
4. **Lepas Remotion:** V6, setelah U3 menghasilkan video setara.
5. **Batch Remix:** Y2–Y5 lalu U5.

## Keputusan terbuka

- **Bahan uji gerbang 1:** 5–10 rekaman mentah asli brand sendiri.
- **Kualitas animasi tanpa Remotion:** FFmpeg + libass bisa caption pop, sorot kata, kotak blur, dan zoom, tetapi animasi rumit (gerak per huruf, efek 3D) lebih terbatas. Diterima?
- **AI untuk hook & label shot:** perlu Claude API key (biaya per pemakaian) atau cukup aturan dulu.
