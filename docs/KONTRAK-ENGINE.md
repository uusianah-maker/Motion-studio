# Kontrak mesin ↔ Motion Studio

Versi: **v0.3 (dikunci)** · 13 November 2026 · disusun venus · catatan batch dari yuki dan reviu ucok sudah masuk. Bentuk final operasi baru di 5.3 masih difinalkan ucok saat U3; perubahan kontrak berikutnya harus disepakati venus, yuki, dan ucok.

Kontrak ini menghubungkan **mesin otomatis** (repo `D:\VIBECODING\remotion`: Generate Otomatis, Batch Remix) dengan **Motion Studio** (repo `D:\VIBECODING\Video motion`). Mesin tidak merender. Mesin menghasilkan rencana edit dalam bentuk operasi timeline Motion Studio, lalu Motion Studio yang menampilkan, menunggu persetujuan, dan merender dengan FFmpeg.

## 1. Alur

```
Motion Studio (runner U6)                    Mesin (CLI V5)
  ekspor Brand Kit + tulis job.json  ─────▶  engine generate <job_dir>
                                             ├─ cek input (ucapan ada? rasio?)
  tampilkan progres  ◀── stdout JSON lines ──┤─ transkrip (Whisper)
                                             ├─ rencana (aturan preset, opsional AI)
  baca rencana.json + ops.json  ◀────────────┘  tulis hasil ke <job_dir>/out/
  impor media, ganti placeholder → MediaRef
  buat proyek draf, terapkan ops (1 undo)
  kartu "Rencana edit siap, render ditahan"
  tim setujui → render FFmpeg → QC → Lulus/Revisi → Editor (finishing)
```

## 2. Perintah

```
engine generate <job_dir>            # Generate Otomatis, satu video
engine batch    <job_dir>            # Batch Remix (yuki), N rencana
engine ulang    <job_dir>            # susun ulang draf memakai <job_dir>/koreksi.json
engine cek                           # cek alat (ffmpeg, whisper, GPU) untuk halaman status
```

- Dijalankan dari `D:\VIBECODING\remotion` dengan Python di `.venv`. Motion Studio memanggilnya sebagai proses anak.
- **Kode keluar:** `0` berhasil · `2` ditolak (input tidak layak, alasan di `rencana.json`) · `1` gagal teknis (boleh dicoba ulang).
- **Progres:** satu objek JSON per baris di stdout: `{"tahap":"transkrip","persen":40,"pesan":"62 kata"}`. Tahap: `cek_input`, `transkrip`, `rencana`, `selesai`. Log lain ke stderr.
- Mesin **tidak** menulis apa pun di luar `<job_dir>` dan tidak pernah menghapus file sumber.

## 3. Input: `<job_dir>/job.json`

```json
{
  "schema": "engine-job/1",
  "job_id": "AYS-20261113-001",
  "mode": "generate",
  "sumber": [{ "kunci": "$sumber", "path": "D:/.../01_INPUT/rekaman.mp4" }],
  "brand_kit": "brand_kit.json",
  "preset": "aysilla-konversi",
  "brief": {
    "produk": "Loose Pants",
    "varian": "Espresso",
    "harga": "",
    "placement": "tiktok",
    "catatan": ""
  },
  "ai": false
}
```

- `sumber[].path`: path file asli di workspace Motion Studio (dibaca saja). `kunci` unik per file: `$sumber` untuk satu video, atau `$sumber:<id>` (mis. `$sumber:IN12`) kalau sumbernya banyak.
- Placeholder audio terpisah: `$vokal:<id>` (stem vokal), `$musik:<id aset>` (musik dari library). Klip video dari file bersuara yang VO-nya diganti dipasang dengan `volume: 0`.

**Tambahan untuk `mode: "batch"` (Batch Remix, yuki):**

```json
{ "mode": "batch", "batch": "2026-11-13_video-winning", "jumlah": 20, "tujuan": "konversi",
  "seed": 42, "izinkan_musik_tanpa_lisensi": false }
```

- Sumber diambil dari `konten/2-dipisah/<batch>/video-bisu/*.mp4`, vokal dari `.../vokal/`.
- `izinkan_musik_tanpa_lisensi`: default `false`. `true` hanya untuk uji; varian yang memakainya ditandai `bukan_iklan: true` dan Motion Studio menolak menandainya Lulus.
- `brand_kit`: file ekspor Brand Kit di dalam `<job_dir>` (bagian 4).
- `harga`: ditulis persis; kosong = mesin tidak menampilkan angka harga apa pun selain yang diucapkan.
- `ai`: `true` = boleh memanggil Claude API untuk hook/kata kunci (butuh API key di `.env` mesin). `false` = aturan saja.

## 4. Ekspor Brand Kit: `<job_dir>/brand_kit.json`

Dibuat Motion Studio (U1) dari Brand Kit brand terpilih. Isinya mengikuti `docs/BRAND-KIT-LENGKAP.md`. Aset ditulis sebagai **placeholder** (`$logo`, `$sfx:pop-01`) beserta path file, supaya mesin bisa membaca durasi/isi tanpa tahu `media_id`.

```json
{
  "schema": "brand-kit-export/1",
  "brand": { "nama": "Aysilla Factory", "kode": "AYS", "handle": { "tiktok": "@aysillafactoryid", "instagram": "@aysillafactoryid" },
             "target": "Wanita 20-35 ...", "nada": ["santai", "meyakinkan", "ceria"], "bahasa": "campur",
             "produk": [{ "nama": "Loose Pants", "varian": ["Espresso", "Black"], "ukuran": "M-XL" }] },
  "visual": { "warna": ["#FFFFFF", "#000000"], "warna_teks": "#FFFFFF", "outline": { "warna": "#000000", "px": 4 },
              "warna_dilarang": ["merah", "kuning", "biru"], "font_judul": "$font:judul", "font_caption": "$font:caption",
              "logo": { "aset": "$logo", "aset_terang": null, "pojok": "tr", "ukuran": 25, "opasitas": 1, "tampil": "sepanjang+penutup" },
              "penutup": { "aset": null, "detik": 2.0 } },
  "teks": { "cta": { "tiktok": "Cek keranjang kuning sekarang", "shopee": "Cek keranjang kuning sekarang", "instagram": "Cek link di bio" },
            "cta_wajib": "", "disclaimer": { "teks": "Warna dapat sedikit berbeda karena cahaya", "kapan": "varian_warna" },
            "kosakata_whisper": ["Aysilla Factory", "Loose Pants"], "kamus": { "Icila Factory": "Aysilla Factory" },
            "kata_kunci": ["anti kusut", "flowy"], "kapital": "kata_kunci", "emoji": false },
  "aturan": { "terlarang": ["paling murah", "termurah", "no. 1", "belum ada yang ngalahin"], "level": "block",
              "harga": [{ "teks": "80rb-an", "berlaku_sampai": "2026-11-30" }], "klaim_boleh": ["bahan adem", "anti kusut"],
              "area_bebas_teks": ["wajah", "produk", "bawah_15", "kanan_tombol"] },
  "aset": [{ "kunci": "$sfx:pop-01", "path": "D:/.../pop-01.wav", "jenis": "sfx", "tag": ["pop", "teks-muncul"], "lisensi_iklan": true }],
  "preset": { "aysilla-konversi": { "...": "isian bagian F" } }
}
```

## 5. Output

Semua di `<job_dir>/out/`.

### 5.1 `rencana.json`: ringkasan untuk kartu "Rencana edit"

```json
{
  "schema": "engine-rencana/1",
  "status": "siap",
  "durasi": { "mentah": 44.6, "akhir": 29.6, "target": [15, 30] },
  "dibuang": [{ "dari": 3.4, "sampai": 10.1, "jenis": "take_ulang", "teks": "...", "sumber": "aturan" }],
  "hook": { "teks": "Males nyetrika celana?", "dari": 0, "sampai": 2.6, "sumber": "aturan" },
  "kata_kunci": [{ "teks": "ANTI KUSUT", "detik": 8.5 }],
  "efek": [{ "jenis": "kotak_kaca", "dari": 0, "sampai": 2.6 }, { "jenis": "zoom", "detik": 8.4 }],
  "audio": { "sfx": 8, "musik": null, "alasan_tanpa_musik": "tidak ada musik berlisensi bertag pop-ceria" },
  "cta": "Cek keranjang kuning sekarang",
  "peringatan": [{ "level": "block", "jenis": "kata_terlarang", "detik": 21.4, "teks": "termurah" }],
  "ragu": [{ "detik": 16.5, "teks": "nggak", "alasan": "Whisper kurang yakin (0.41)" }]
}
```

`status`: `siap` · `ditolak` (dengan `alasan`, mis. "tidak ada ucapan terdeteksi") · `perlu_keputusan` (mis. durasi masih di atas target setelah membuang jeda; tim memilih bagian tengah).

### 5.2 `ops.json`: rencana dalam bentuk operasi timeline Motion Studio

```json
{
  "schema": "ms-ops/1",
  "ops": [
    { "op": "set_canvas", "ratio": "9:16" },
    { "op": "set_brand_logo", "on": true },
    { "op": "add_clip", "track_kind": "video", "media": "$sumber", "start_ms": 0, "duration_ms": 3400, "in_ms": 0 },
    { "op": "add_clip", "track_kind": "video", "media": "$sumber", "start_ms": 3400, "duration_ms": 9000, "in_ms": 10130 },
    { "op": "add_clip", "track_kind": "subtitle", "text": "Males nyetrika celana?", "start_ms": 0, "duration_ms": 1500,
      "words": [{ "text": "Males", "start_ms": 0, "end_ms": 400 }, { "text": "nyetrika", "start_ms": 400, "end_ms": 900 }, { "text": "celana?", "start_ms": 900, "end_ms": 1500 }],
      "style": { "y": 0.72, "anim": "pop", "highlight": { "words": ["nyetrika"] } } },
    { "op": "add_clip", "track_kind": "sfx", "media": "$sfx:pop-01", "start_ms": 100, "duration_ms": 180, "volume": 0.8 }
  ]
}
```

**Aturan wajib untuk mesin (dari reviu ucok):**

1. **Kanvas & logo sebagai operasi biasa** (`set_canvas`, `set_brand_logo`) di awal `ops`, bukan field di luar `ops`. Satu jalur validasi.
2. **Rencana tidak boleh merujuk `clip_id` yang dibuatnya sendiri.** Jangan `add_clip` lalu `set_style`/`set_volume` ke klip itu. `style` dan `volume` ditaruh langsung di `add_clip` (`volume` di `add_clip` ditambah ucok di U3).
3. **Satu track per jenis, klip dalam satu track tidak boleh tumpang tindih.** SFX tidak boleh menumpuk di track `audio` bersama musik/VO. SFX ke track baru `sfx` (nama final dari ucok di U3).
4. **Caption per frasa, bukan per kata:** satu klip `subtitle` per frasa (maks kata sesuai preset) dengan `words: [{ text, start_ms, end_ms }]` + `style.anim` + `style.highlight`. Render memakai karaoke libass. Waktu `words` relatif terhadap timeline hasil.
5. **Maks 1000 operasi per rencana.** Operasi X07 (`remove_range`, `split_at`) boleh dipakai.
6. `media` berisi **placeholder** (`$sumber`, `$sumber:<id>`, `$vokal:<id>`, `$musik:<id>`, `$sfx:<id>`, `$logo`). Runner yang mengganti dengan `MediaRef`, dan **menolak placeholder yang tidak ada** di `sumber[]` atau aset Brand Kit (tidak ada tebakan).
7. Waktu dalam ms pada **timeline hasil**, bukan waktu sumber. `in_ms` = posisi di file sumber.
8. Rencana masuk lewat **jalur rencana Motion Studio** yang sudah ada (sumber `engine`): diff → setujui → satu langkah undo ("Draf Generate Otomatis"). Brand guard X08 tetap memeriksa. Render hanya setelah disetujui.

### 5.3 Operasi & gaya baru yang dibutuhkan (diusulkan; ucok yang memfinalkan di U3)

Hasil uji 13 Nov memakai efek yang belum ada di Motion Studio. Usulan bentuknya:

| Kebutuhan | Usulan di Motion Studio |
| --- | --- |
| Caption per kata muncul dengan "pop" | `Clip.words` (waktu per kata) + `TextStyle.anim: 'none' \| 'pop' \| 'fade'` + `anim_ms`, render karaoke libass |
| Sorot kata kunci di caption | `TextStyle.highlight: { words: string[], color, scale, box: boolean }` |
| SFX bersamaan dengan musik/VO | track baru `sfx` (atau `music`), nama final dari ucok |
| Volume saat klip dibuat | `volume` di `add_clip` |
| Dua font (judul & caption) | `TextStyle.font: 'default' \| 'judul' \| 'caption'` (U1) |
| Judul kotak kaca (blur di belakang teks) | `TextStyle.bg_blur: number` (radius) |
| Digital zoom / punch-in pada video | klip di track `effects`: `{ effect: 'zoom', scale, mode: 'cut' \| 'smooth' }` |
| Transisi zoom-through | klip `effects`: `{ effect: 'zoom_through' }` di titik potong |
| Penutup logo / video | klip `effects`: `{ effect: 'outro', media?, detik }` memakai Brand Kit |
| Disclaimer kecil | preset teks `disclaimer` (track `text`, ukuran kecil) |
| Loudness akhir | pengaturan render proyek `loudness_lufs: -14` |
| Blur area per klip (watermark, teks bawaan) — Batch Remix | `Clip.blur: [{ x, y, w, h, dari_ms, sampai_ms, radius }]`, waktu dihitung terhadap `in_ms` sumber (watermark TikTok pindah posisi di detik 5,0 sumber) |
| Crop / zoom statis per klip (buang wajah kreator lain) — Batch Remix | `Clip.crop: { x, y, w, h }` (0..1), lalu di-scale ke kanvas |

Blur watermark hanya boleh dipakai pada footage yang hak pakainya jelas milik brand (lihat keputusan hak pakai IN1–IN23, masih terbuka).

Sampai operasi ini ada, mesin hanya memakai operasi yang sudah ada (caption tanpa animasi, tanpa zoom). Draf tetap bisa dirender.

### 5.3a Output batch

```
<job_dir>/out/batch.json            tabel N baris: id varian, VO, hook, daftar shot, musik, durasi,
                                    status: usul | dicoret | disetujui, bukan_iklan
<job_dir>/out/varian-001/rencana.json + ops.json
<job_dir>/out/varian-002/...
```

Tim mencoret/menyetujui di tabel (U5), runner hanya merender varian berstatus `disetujui`.

### 5.4 `qc_rencana.json`: cek sebelum render

Mesin mengecek yang bisa dicek dari rencana: durasi, hook di 3 detik pertama, ejaan sesuai kamus, angka hanya dari brief/ucapan, kata terlarang, jumlah efek ≤ batas preset, posisi caption tidak di `area_bebas_teks`. Cek sesudah render (resolusi, loudness, logo tampil) tetap di Motion Studio.

## 6. Koreksi & ulang: `<job_dir>/koreksi.json`

Dipakai kalau tim ingin draf disusun ulang oleh mesin (bukan diedit manual di timeline):

```json
{ "kata": [{ "detik": 12.3, "jadi": "Loose Pants", "simpan_ke_kamus": true }],
  "buang": [[15.1, 18.6]], "pakai": [[21.0, 22.4]], "hook": "Males nyetrika celana?" }
```

`engine ulang` membaca koreksi lalu menulis `rencana.json` + `ops.json` baru. Koreksi `simpan_ke_kamus` dikembalikan ke Motion Studio lewat `rencana.json` (`kamus_baru`), dan Motion Studio yang menyimpannya ke Brand Kit.

## 7. Yang sudah disepakati (reviu ucok, 13 Nov 2026)

1. **Ekspor Brand Kit (bagian 4) & `job.json`** dibuat runner U6.
   - Path aset = path absolut di workspace. Mesin hanya membaca.
   - `brand.kode` **wajib dan unik per workspace** (dipakai di `job_id`).
   - Dua peran font: `judul` dan `caption` (U1).
   - `aturan.harga` / `terlarang` / `level` dipetakan dari Brand guard X08 (`guard.prices` / `banned` / `banned_level`).
2. **Placeholder → `MediaRef` oleh runner.** Placeholder yang tidak dikenal ditolak. Selama mesin jalan, runner memegang *lease* atas versi sumber supaya Auto Trash tidak memindahkannya.
3. **Operasi baru (5.3)**: arahnya disetujui. Bentuk final dikirim ucok saat U3 mulai. Sampai itu, mesin hanya memakai operasi yang sudah ada dan mengikuti aturan wajib di 5.2.
4. **`<job_dir>` = `PROJECTS/<proyek>/06_ENGINE/<job_id>/`**: folder baru di layout proyek, area izin sendiri (bukan area media, tidak dipindai GC, ikut backup dan hapus proyek). Ditambah ucok di U6.

## 8. Tambahan v0.3.1 (aditif, 13 Nov 2026 — dari implementasi V3/V5)

Tidak mengubah apa pun yang sudah disepakati; hanya menambah field opsional.

| Di mana | Field | Arti |
| --- | --- | --- |
| `job.json` | `mode_ops`: `kompat` (default) · `u3` | `kompat` = hanya operasi/field yang sudah diterima Motion Studio sekarang; `u3` = ikut field usulan 5.3 |
| `job.json` `brief` | `area_produk`: `bawah` · `atas` · `penuh` (opsional) | letak produk di frame; caption menghindarinya (wajah tetap prioritas) |
| `job.json` `brief` | `placement`: juga `shopee`, `youtube` | CTA diambil dari Brand Kit per platform, jatuh ke `tiktok` kalau kosong |
| `job.json` mode `batch` | `akun_sendiri: string[]` (opsional) | akun watermark milik brand; footage ber-watermark akun lain tidak dipakai (kosong = semua dipakai + peringatan) |
| `job.json` mode `batch` | `hak_pakai_jelas: bool` (default `false`) | `true` = blur watermark/teks bawaan boleh dipasang (5.3: hanya untuk footage milik brand) |
| `job.json` mode `batch` | `shot_tiktok: bool` (opsional) | paksa anggap semua footage unduhan TikTok (watermark + footer) saat membuat Shot Library |
| `ops.json` | `mode`, `aset_lokal: [{ kunci, path }]` | aset milik mesin (mis. SFX bawaan `$sfx:pop`; Batch Remix: `$vokal:<id>`, `$musik:<id>`) selama library aset per brand (U2) belum ada; runner mengimpor sebagai media proyek seperti placeholder lain |
| `rencana.json` | `menunggu_u3: string[]` | efek yang dilewati di mode `kompat` (caption pop, kotak kaca, zoom, penutup logo, volume SFX), ditampilkan di kartu rencana |
| `rencana.json` | `posisi_caption` (0..1) | pusat vertikal caption hasil deteksi wajah |
| `rencana.json` | `kamus_baru: { salah: benar }` | hanya dari `engine ulang`; Motion Studio menyimpannya ke Brand Kit |

Mode `kompat` sudah diuji dengan `validateOps` + `applyOps` asli Motion Studio (`pipeline/validasi_ops.mjs`).
Di mode ini caption per frasa memakai `font: "caption"`, hook & CTA `font: "brand"`, dan SFX di track `audio` (tidak ada musik).
