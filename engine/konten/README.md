# Folder konten — alur kerja tim

Semua video tim lewat 3 tahap, berurutan sesuai nomor folder.

```
konten/
├─ 1-upload/<batch>/          ← TIM: taruh video mentah di sini
├─ 2-dipisah/<batch>/         ← OTOMATIS: hasil pisah audio
│   ├─ video-bisu/            video tanpa suara
│   ├─ audio-asli/            audio utuh (campur)
│   ├─ vokal/                 suara orang saja
│   ├─ musik/                 musik/backsound saja
│   ├─ transkrip/             transkrip vokal (Whisper)
│   └─ shots.json             Shot Library (Batch Remix)
└─ 3-hasil/<batch>/           ← VIDEO JADI, siap upload (sudah MetaClean)
    ├─ tiktok/
    └─ instagram/
```

## Nama batch

Satu kali upload = satu folder batch: `YYYY-MM-DD_keterangan`, huruf kecil, tanpa spasi.
Contoh: `2026-11-13_video-winning`, `2026-11-20_kreator-loosepants`.

## Cara pakai

1. **Upload.** Buat folder batch di `1-upload/`, isi dengan video `.mp4` / `.mov`.
   Nama file pendek tanpa spasi (mis. `IN1.mp4`, `kreator-a-01.mp4`).
   Kalau ada, pakai **footage mentah tanpa watermark TikTok** — hasil jauh lebih bersih.
2. **Pisahkan.** Dari `D:\VIBECODING\remotion`:
   ```
   .venv\Scripts\python pipeline\pisah.py <batch>
   ```
   Hasil masuk ke `2-dipisah/<batch>/`. Aman dijalankan ulang: video yang sudah dipisah dilewati.
3. **Edit & render.** Minta ke Claude (skill `remotion-konversi` / `remotion-branding` / `remotion-awareness`,
   atau nanti Batch Remix di dashboard). Rencana edit selalu disetujui dulu sebelum render.
   **Batch Remix** (banyak varian dari footage campuran): sesudah langkah 2, jalankan Shot Library sekali per batch
   lalu perencana. Detail di `pipeline/batch/README.md`:
   ```
   D:\VIBECODING\tools\demucs-venv\Scripts\python pipeline\batch\shotlib.py <batch>
   .venv\Scripts\python pipeline\engine.py batch <job_dir>
   ```
   Hasilnya rencana (tabel `batch.json` + `rencana.json`/`ops.json` per varian) untuk disetujui di Motion Studio,
   bukan video jadi. Pratinjau kasar: `pipeline\batch\pratinjau.py <job_dir> varian-001 --blur`.
4. **Ambil hasil.** Video final ada di `3-hasil/<batch>/tiktok/` dan `instagram/`.

## Aturan

- Jangan hapus isi `1-upload/` — itu sumber asli.
- Musik dari `2-dipisah/<batch>/musik/` asalnya dari video lain: **lisensinya belum jelas**,
  jangan dipakai untuk iklan berbayar sebelum dicek.
- Folder ini tidak masuk git (file besar), kecuali README ini.
