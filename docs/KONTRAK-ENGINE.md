# Kontrak mesin ↔ Motion Studio

Versi: **v0.3.2** · 14 November 2026 (v0.3 dikunci 13 Nov; 0.3.1–0.3.2 aditif) · disusun venus · catatan batch dari yuki dan reviu ucok sudah masuk. Bentuk final operasi baru di 5.3 masih difinalkan ucok saat U3; perubahan kontrak berikutnya harus disepakati venus, yuki, dan ucok.

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
engine pisah    <job_dir>            # Batch Remix: unggahan -> pisah audio + Shot Library (v0.3.2)
engine daftar_batch                  # daftar batch untuk dropdown, read-only (v0.3.2)
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

Blur watermark hanya boleh dipakai pada footage yang hak pakainya jelas (`hak_pakai_jelas: true`), diputuskan owner **per batch**. Default batch baru: `false`.

**Keputusan owner 13 Nov 2026 (dijawab di sesi yuki): "Semua boleh"** untuk batch `2026-11-13_video-winning` (IN1–IN23): footage dari semua akun watermark (@aysilla_factory, @aln_store.id, @distcover IN18, @vionaputri_17 IN1/IN21) boleh dipakai untuk iklan.

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
| `job.json` mode `batch` | `buang_otomatis: string[]` (opsional) | jenis kalimat VO yang boleh dibuang otomatis (mis. `superlatif`, `urgensi`, `live`, `musiman`). Default kosong = semua kalimat dipakai, pelanggaran hanya jadi peringatan `saran_buang` (keputusan owner 13 Nov 2026) |
| `job.json` mode `generate` & `batch` | `batas_durasi: [min, maks]` (opsional) | default tanpa batas; `rencana.durasi.target = null`, `durasi.saran` hanya info |
| `out/batch.json` (mode `batch`) | `media: { "<placeholder>": "<path>" }` | footage/vokal per placeholder (`$sumber:<id>`, `$vokal:<id>`, `$musik:<id>`) yang diimpor runner U6; path relatif ke root mesin atau absolut **di dalam** root mesin |
| `rencana.json` | `menunggu_u3: string[]` | efek yang dilewati di mode `kompat` (caption pop, kotak kaca, zoom, penutup logo, volume SFX), ditampilkan di kartu rencana |
| `rencana.json` | `posisi_caption` (0..1) | pusat vertikal caption hasil deteksi wajah |
| `rencana.json` | `kamus_baru: { salah: benar }` | hanya dari `engine ulang`; Motion Studio menyimpannya ke Brand Kit |

Mode `kompat` sudah diuji dengan `validateOps` + `applyOps` asli Motion Studio (`pipeline/validasi_ops.mjs`).
Di mode ini caption per frasa memakai `font: "caption"`, hook & CTA `font: "brand"`.

**Sejak U3a (ucok, 269aee8):** `set_loudness` (lufs dari preset, default −14) di awal `ops`; SFX di track `sfx` dengan `volume`; musik latar di track `music` (U3b, `volume` 0,12) hanya kalau aset musik `instrumental: true` + `lisensi_iklan: true`; penutup brand = klip `broll` media `visual.penutup.aset` sesudah video, CTA di atasnya.

**Sejak U3b (ucok, 6330cba):** caption per frasa membawa `words` (waktu RELATIF ke awal klip, satu token per kata, maks 30 kata/klip) + `style.anim: "pop"` + `style.highlight: { words: [kata kunci huruf kecil per kata], color: aksen, scale: 1.4, current: false }`. Kata kunci tetap KAPITAL kalau `teks.kapital = "kata_kunci"`.

**Sejak U3c/U3d (ucok, d395518):** hook = kotak kaca (`bg: "#ffffff"`, `bg_opacity: 0.16`, `bg_blur: 12`); `highlight.box: true` kalau warna aksen sama dengan warna caption; track `effects` berisi `{ effect: { type: "zoom", scale, mode, x, y } }` (berlaku sampai ganti framing berikutnya, skala < 1,02 tidak dipasang) dan `{ effect: { type: "zoom_through", scale: 1.4 } }` ±150 ms di titik potong (rentang zoom dipotong di sekitarnya, tidak tumpang tindih); disclaimer = klip track `text` gaya preset `disclaimer` di sela hook dan CTA. `mode_ops` `kompat` dan `u3` sekarang menghasilkan isi yang sama.

**Tiga lajur suara berbunyi bersamaan:** `audio` (VO / suara asli terpisah), `music`, `sfx`. Masing-masing tidak boleh tumpang tindih di dalam lajurnya sendiri. Suara asli di dalam klip `video` tetap ikut kecuali `volume: 0`.

### Aturan runner U6 yang berlaku untuk mesin (audit Checkpoint I ucok, 13 Nov 2026)

1. **Impor media dari folder mesin** mengikuti *realpath* dan hanya menerima file media (mp4, mov, m4v, webm, mkv, wav, mp3, m4a, aac, ogg, opus, flac, png, jpg, webp). Path di luar root mesin ditolak. Berlaku untuk `aset_lokal` dan `batch.json` `media`.
2. **Lingkungan proses mesin dibatasi** (allowlist: PATH, SYSTEMROOT, TEMP/TMP, USERPROFILE/APPDATA/LOCALAPPDATA, PYTHON*, VIRTUAL_ENV, HF_HOME, XDG_CACHE_HOME, CUDA_VISIBLE_DEVICES, …). Rahasia seperti `ANTHROPIC_API_KEY` dibaca mesin dari `.env` miliknya sendiri, bukan dari lingkungan Motion Studio. **Wajib ada:** `USERPROFILE` atau `HF_HOME` (Whisper mencari cache model di sana; tanpa keduanya transkrip gagal).
3. **Status:** kode keluar 0 dengan `rencana.status: "ditolak"` diperlakukan sebagai ditolak; `perlu_keputusan` tetap siap, dengan pesan.

## 9. Tambahan v0.3.2 (aditif, 14 Nov 2026 — Batch Remix untuk Motion Studio, permintaan ucok via yuki)

| Bagian | Isi | Keterangan |
| --- | --- | --- |
| `engine pisah <job_dir>` | `job.json` `{ "mode": "pisah", "batch", "video_saja"?, "shot_tiktok"? }`, video unggahan di `<job_dir>/masuk/` | Menjalankan `pipeline/pisah.py --job`. Video disalin ke `konten/1-upload/<batch>` (nama sama tapi isi beda → akhiran `-2`), dipisah, lalu Shot Library + thumbnail dibuat untuk footage baru. Hasil: `out/pisah.json` `{ schema: "pisah/1", status, batch, dipisah_pada, video_saja, hasil: [{ file, video, vokal, musik }], shot_library, jumlah_shot }`; kalau ditolak `{ schema, status: "ditolak", alasan }`. Progres JSON-lines di stdout. Kode 0 / 2 ditolak / 1 gagal |
| `engine daftar_batch` | tanpa `job_dir` | Read-only. Stdout satu JSON `{ "schema": "daftar-batch/1", "batch": [{ batch, upload, footage, vo, musik, dipisah, dipisah_pada, shot_library, jumlah_shot, thumb, siap_batch }] }`. Kode 0 |
| `job.json` mode `batch` | `kecualikan_shot: string[]` (opsional) | id shot pilihan tim (disimpan di app) yang tidak dipakai, baik sebagai b-roll maupun sinkron |
| `out/batch.json` per varian | `kalimat: [{ teks, dari, sampai, shot: [id] }]` | detik di timeline varian |
| `shots.json` per shot | `thumb` | path absolut JPG (lebar 270) di `konten/2-dipisah/<batch>/thumb/<footage>__NN.jpg`; batch lama dilengkapi dengan `shotlib.py <batch> --thumb-saja` |

**Status di `out/pisah.json` (v0.3.2a):**
- Status bisa `selesai`, `ditolak`, atau `gagal`, masing-masing dengan `alasan`. Status `gagal` juga ditulis sebelum kode keluar 1.
- Kalau selesai, ada `file_ditolak: [{ file, alasan }]`, yaitu unggahan rusak atau bukan video. File itu dilewati, tidak menggagalkan job. Kalau semua unggahan rusak dan batch belum ada, job ditolak dengan kode 2.
- Duplikat unggahan dikenali dari sidik isi file.
- Tanpa GPU, Demucs otomatis memakai CPU.

**`engine batch` ditolak (v0.3.2a):** penolakan memakai kode 2, dengan `out/rencana.json` `{ schema: "engine-rencana/1", status: "ditolak", alasan }` dan progres `ditolak`. Penolakan terjadi kalau:
- batch tidak ada atau belum dipisah;
- batch VO tidak ada;
- mode salah;
- 0 varian. Untuk kasus ini `batch.json` tetap ditulis.

**Pengecualian aturan bagian 2:** `engine pisah` adalah satu-satunya perintah yang menulis di luar `<job_dir>`. Ia menulis ke `konten/` (folder data Batch Remix di root mesin). Motion Studio tetap tidak menulis ke folder mesin. Ia hanya meletakkan unggahan di `<job_dir>/masuk/`.

**Progres `engine batch` sejak v0.3.2:** progres JSON-lines dari `perencana.py` sekarang benar-benar sampai di stdout. Sebelumnya ikut terbelokkan ke stderr. Runner sebaiknya mengabaikan baris stdout yang bukan JSON.

**Keputusan owner 14 Nov 2026 (Batch Remix): satu-satunya pengecualian dari "kalimat VO tidak dibuang otomatis".**
- Kalimat VO yang menyebut brand atau toko lain **selalu dibuang otomatis** dan dicatat di QC `brand_lain` (yuki, 4e1073b + aba89de). Kata owner: "Ya, buang otomatis".
- Kalimat superlatif, urgensi, live, musiman, dan soal durasi tetap mengikuti `buang_otomatis`. Defaultnya tidak dibuang dan hanya diberi peringatan.

## 10. Pengaman ops (v0.3.3, 14 Nov 2026, venus)

Mesin menjaga sendiri supaya Motion Studio tidak pernah menerima ops yang tidak valid (`pipeline/jaga_ops.py`, dipakai Generate dan Batch Remix):
- **Klip ≤ panjang file sumber.** Batasnya diukur dengan ffprobe dari file asli, dikurangi 1 frame. Klip yang kelebihan dipendekkan. Klip yang sisanya kurang dari 100 ms dibuang.
- **Teks kosong dibuang.** Contohnya CTA saat Brand Kit belum punya CTA. Teks lebih dari 500 karakter dipotong.
- **Waktu kata caption (`words`) dirapikan** supaya urut, tidak tumpang tindih, dan berada di dalam klip.
- **Gerbang akhir:** setiap `ops.json` diuji dengan validator asli Motion Studio (`validasi_ops.mjs`).
  - **Batch Remix:** varian yang tetap ditolak mendapat `"rusak": "<alasan>"` di baris `out/batch.json`, `qc_lulus: false`, dan peringatan `block` `rusak`. Varian rusak **tidak boleh** bisa disetujui. Varian lain tetap bisa disimpan.
  - **Generate:** ditolak berarti kode 1 dengan alasan yang jelas.
- Setiap perubahan oleh pengaman dicatat sebagai peringatan `info` `durasi_sumber` di `rencana.json`.


## 11. Anti konten-tidak-orisinal di Batch Remix (v0.3.4, 14 Nov 2026, keputusan owner)

Aditif. Tidak ada field output yang dihapus; app tidak perlu berubah.

| Aturan | Nilai |
|---|---|
| Pembuka (potongan pertama) | selalu b-roll footage lain, bukan detik pertama video asli; judul hook tetap tampil sebagai teks |
| Gambar dari footage asli VO (sinkron) | maks 35% durasi (`matcher.MAKS_SINKRON`); varian > 45% dibuang |
| Varian dengan VO sama dianggap mirip bila | Jaccard semua shot (b-roll + sinkron) > 0,4, ATAU shot pembuka sama, ATAU > 50% kalimat bergambar identik |
| Audio | susunan kalimat tidak boleh identik antar varian VO sama: 1-2 kalimat tengah dibuang dan/atau dua kalimat tengah yang berdiri sendiri ditukar; hook & CTA tetap. Kalimat yang dibuang tercatat di `dibuang` dengan `jenis: "variasi"` |
| Varian per VO | maks 3 (job opsional `maks_per_vo: int`). Kurang dari `jumlah` -> `alasan_kurang` menjelaskan dan meminta VO baru |

## 12. Tambahan aplikasi (opsional untuk mesin) — v0.3.5, 15 Nov 2026 (kerja malam, fitur pilihan owner dari audit CapCut)

**Aditif.** Semua field di bawah **opsional**. Ops lama dan proyek lama tetap valid tanpa field ini. Mesin **tidak wajib** mengirimnya. Kalau dikirim, Motion Studio memvalidasinya sama ketatnya dengan field lain (field tidak dikenal / nilai di luar rentang = ditolak). Teknik meniru CapCut, tapi semua filter, preset, dan namanya dibuat sendiri dengan FFmpeg. Tidak ada file, LUT, sticker, atau font milik CapCut/ByteDance.

### 12.1 Field baru di `add_clip` (dan di klip yang tersimpan)

| Field | Boleh di | Nilai | Arti |
|---|---|---|---|
| `fade_in_ms`, `fade_out_ms` | klip media apa pun (video, b-roll, audio, music, sfx) | 0–10000 (0 = tanpa) | Suara klip naik/turun pelan di awal/akhir klip |
| `denoise` | klip media | `"off"` \| `"ringan"` \| `"sedang"` | Reduksi noise suara (`highpass` + `afftdn`). Hanya terdengar di hasil render |
| `fit` | klip media di track `video` / `broll` | `"isi"` \| `"blur"` \| `"warna"` | Cara gambar mengisi canvas. Tidak ada = pas + latar hitam (perilaku lama). `isi` = crop memenuhi layar. `blur` = pas + latar salinan gambar yang diburamkan. `warna` = pas + latar `fit_color` |
| `fit_color` | idem | `"#rrggbb"` | Warna latar untuk `fit: "warna"` |
| `adjust` | idem | objek `{terang, kontras, saturasi, suhu}` −100..100 dan `{tajam, vignette}` 0..100; field yang tidak ada = 0 | Penyesuaian warna (`eq`, `colortemperature`, `unsharp`, `vignette`) |
| `look` | idem | `"hangat"` \| `"sejuk"` \| `"cerah"` \| `"pastel"` \| `"tegas"` \| `"hitamputih"` \| `"senja"` \| `"adem"` \| `"none"` | Filter warna buatan sendiri. `"none"` = tanpa filter walau brand punya filter bawaan. Tidak ada = ikut filter bawaan brand |
| `transition` | idem | `{ "type": "dissolve" \| "geser_kiri" \| "geser_kanan" \| "wipe" \| "flash", "ms": 200–1500 }` (ms default 500) | Transisi MASUK ke klip ini dari gambar sebelumnya (`xfade`). Durasi total video tidak berubah: klip sebelumnya diperpanjang ½ transisi, klip ini mulai ½ transisi lebih awal (bila sumbernya tidak cukup, frame pertama ditahan). Suara tetap potong biasa (tetap sinkron). Dibatasi otomatis oleh panjang kedua klip |

Zoom-through tetap memakai efek lama (`effect: {type: "zoom_through"}` di track `effects`).

### 12.2 Operasi baru

```json
{ "op": "set_audio", "clip_id": "...", "fade_in_ms": 300, "fade_out_ms": 800, "denoise": "ringan" }
{ "op": "set_picture", "clip_id": "...", "fit": "blur", "fit_color": null, "adjust": {"suhu": 20}, "look": "hangat", "transition": {"type": "dissolve", "ms": 500} }
{ "op": "set_ducking", "on": true, "level": 0.3 }
```
- `set_audio`: minimal satu field. `fade_*_ms: 0` menghapus fade, `denoise: "off"` mematikan.
- `set_picture`: minimal satu field. `null` menghapus field itu. `adjust` yang semuanya 0 = dihapus.
- `set_ducking`: menyimpan `duck` (0.1–0.8, default 0.3) di **track `music`**. Musik turun ke level itu saat ada suara bicara: klip track `audio` dan suara klip track `video` yang terdengar (tidak dibisukan, volume > 0, sumbernya punya audio). Rentang yang jaraknya ≤ 400 ms digabung. Turun/naik dalam 200 ms.

### 12.3 Brand Kit
- Field baru `filter_bawaan`: salah satu id `look` di atas, atau `null`. Dipakai semua klip video/b-roll proyek brand itu yang tidak punya `look` sendiri. Kit lama = `null`.

### 12.4 Split / potong jeda
- Klip yang dipotong: fade masuk dan transisi tetap di potongan kiri (awal klip). Fade keluar pindah ke potongan kanan (akhir klip). Filter, adjust, fit, dan reduksi noise ikut ke dua potongan.

### 12.5 Keyframe (posisi, skala, opacity)
- Field opsional `keyframes` di `add_clip` dan klip tersimpan, untuk klip **video / b-roll (dengan media), teks, subtitle**. Maksimal 20 titik:
  `[{ "at_ms": 0, "x": 0, "y": 0, "scale": 1, "opacity": 1, "ease": "linear" | "ease" }, ...]`
  - `at_ms`: waktu di dalam klip (0 = awal klip). Boleh di luar klip (hasil split/trim) sebagai jangkar kurva.
  - `x`, `y`: geser dari posisi normal, pecahan canvas −1..1. `scale` 0.1..4 (di sekitar titik tengah klip). `opacity` 0..1 (gambar memudar ke hitam, teks memudar).
  - `ease`: kurva dari titik sebelumnya ke titik ini (`ease` = ease-in-out). Field yang tidak ada memakai nilai netral.
- Operasi baru: `{ "op": "set_keyframes", "clip_id": "...", "keyframes": [...] }` (`[]` = hapus semua).
- Batas: keyframe di teks **tidak bisa** digabung dengan caption kata per kata (`words`), animasi `pop`/`fade`, atau sorot kata. Ops seperti itu ditolak dengan alasan jelas.
- Split/trim/potong jeda menjaga gerakan yang sama di tiap potongan.

## 13. Riwayat pakai lintas batch (R6, v0.3.6, 15 Nov 2026, yuki — keputusan owner no. 16)

Aditif. App tidak wajib berubah; semua field opsional.

- Konten yang sudah dipakai tidak dipakai berulang, **termasuk antar batch**. Mesin menyimpan riwayat **per brand** (kode Brand Kit, mis. `AYS`) di `konten/riwayat/<kode>.json` (atau folder env `MOTION_RIWAYAT_DIR`). File ini data mesin, di luar folder job, tidak di-commit.
- Isi per varian: `job_id`, `varian`, batch gambar & batch VO, footage VO, `urutan` kalimat VO, `pembuka`, semua shot, shot per kalimat, `status`.
- Saat menyusun batch baru:
  - shot yang pernah jadi **pembuka** (batch gambar sama) tidak dipakai lagi sebagai pembuka;
  - **susunan kalimat VO** yang pernah dipakai tidak diulang;
  - varian dengan VO sama dibandingkan juga dengan riwayat memakai aturan mirip §11;
  - shot yang pernah dipakai dipilih paling akhir (penalti Matcher).
  Kalau stok habis, varian berkurang dan `alasan_kurang` menyebut riwayat.
- Job yang dijalankan ulang (job_id sama) **mengganti** entrinya sendiri, jadi tidak membatasi dirinya sendiri.
- Status entri: `direncanakan` (dicatat saat batch selesai; default sampai app mengirim keputusan) · `disetujui` · `dirender` · `dicoret` (tidak dihitung). Jalan ulang job yang sama: entri `disetujui`/`dirender` **tidak pernah dihapus** (tetap dihitung, ditandai `diganti` bila varian baru isinya beda); status lama hanya dibawa ke varian baru yang isinya identik. Job tanpa `job_id` memakai nama folder job.
- File riwayat rusak tidak menggagalkan batch: dipindah ke `<kode>.rusak-<waktu>.json`, batch memakai riwayat kosong dan `batch.json.riwayat.peringatan` menjelaskannya.
- `job.json` batch, field opsional baru: `abaikan_riwayat: true` → riwayat tidak dibaca **dan** job ini tidak dicatat (hybrid, prinsip owner).
- `batch.json`, field baru: `riwayat: {aktif, brand, entri_dihitung, pembuka_dihindari, dicatat, ditolak_karena_riwayat}` atau `{aktif: false, alasan}`.
- Perintah (read/write data mesin, dari root repo): `python pipeline/batch/riwayat.py lihat|reset <brand>` · `tandai <brand> <job_id> <status> [varian...]` · `lepas <brand> <job_id> [varian...]`. `reset` menyimpan cadangan `<kode>.reset-<waktu>.json`.
- Disarankan untuk app (belum wajib): saat tim mencoret varian, panggil `lepas`; saat render selesai, `tandai ... dirender`. Jalurnya lewat `engine.py` (milik venus).

## 14. Generate: lagu, teks bawaan, CTA kosong (v0.3.7, 15 Nov 2026, venus — R1–R3)
- **R1 (G1)** Audio yang terdeteksi lirik lagu (kata Inggris > 35 % atau kata Indonesia < 8 %) → `rencana.status: "ditolak"`, kode keluar 2. Field opsional `job.json`: `abaikan_cek_ucapan: true` → tetap dibuat rencana dengan peringatan `jenis: "ucapan"` (tombol "Tetap lanjut" di app; hybrid).
- **R2 (G2)** Hook tidak menimpa teks bawaan video. Mesin membaca teks (OCR) dan wajah di rentang hook, lalu menggeser `hook.top` ke kandidat 0.30 / 0.18 / 0.10 / 0.48 / 0.56. Teks wajib dihindari, wajah diusahakan. Tidak ada tempat → hook dilewati, peringatan `jenis: "hook"`, butir QC hook tetap lulus dengan `nilai` "dilewati". Catatan geser ada di `rencana.ragu`. `potongan.json.cekTeksBawaan` = `{dicek, kotak, wajah, catatan}` atau `{dicek: false, gagal}` (OCR gagal tidak menghentikan rencana). Posisi pilihan tim selalu menang: `--hook-top`, atau `koreksi.json` field `hook_top` (0..1) lewat `engine ulang`.
- **R3 (G6)** CTA Brand Kit kosong → peringatan `jenis: "cta"`; teks "CTA ditampilkan di … dtk terakhir" tidak muncul lagi.

## 15. Motion Transfer tahap 1 (R11, v0.3.8, 15 Nov 2026, venus)
- Perintah baru: `engine transfer <job_dir>`. `job.json`: `mode: "transfer"`, `sumber` `$sumber` = video referensi (boleh tanpa suara, rasio apa pun), `brief.produk` dan `brief.deskripsi_produk` opsional (default produk pertama Brand Kit).
- Hasil: `out/transfer.json` (schema `engine-transfer/1`: `referensi`, `durasi`, `produk`, `adegan[]` = `{no, dari, sampai, durasi, detik_gambar, gambar, prompt_gambar, prompt_gerak, sumber}`) + `out/adegan/NN.jpg` (lebar 1080, frame paling tajam di tengah adegan). Adegan < 0,8 dtk digabung, > 4 dtk dipecah, tanpa celah.
- Tahap 2–3 belum memanggil API AI: prompt disalin manual oleh tim (hybrid, tanpa biaya). Kode keluar 0 siap · 2 ditolak (`rencana.json` status ditolak) · 1 gagal.

## 16. Beat Spot tahap 1 (R16, v0.3.9, 15 Nov 2026, yuki — nama dari owner)

Video **awareness**: footage orang jalan (di mall) memakai produk brand dipotong per orang, pergantian **tepat di ketukan** sound, logo brand + end card dari Brand Kit. Tanpa AI ganti pakaian (tahap 2 ditahan menunggu owner). Aditif; mode baru.

- Perintah: `engine beatspot <job_dir>` → `pipeline/batch/beatspot.py`. Progres JSON-lines (`cek_input` → `ketukan` → `shot` per footage → `susun` → `tulis` → `selesai` / `ditolak`). Kode keluar 0 / 2 (alasan di `rencana.json`) / 1.
- `job.json`: `mode: "beatspot"`, `sumber: [{kunci: "$sumber:<id>", path}]` (footage video + 1 file sound milik tim, video atau audio), `brand_kit`, dan
  ```json
  "beatspot": { "sound": "$sumber:<id>" | null, "bpm": 120 | null, "ketukan_per_potong": "auto" | 1 | 2 | 4,
                "durasi": [15, 20], "tagline": "..." | null, "urutan_shot": ["<id>#NN"], "kecualikan_shot": [],
                "sumber_orang": { "<id footage>": "kreator", "<id shot>": "umum" }, "seed": 1 }
  ```
  - `sound` null: kalau ada tepat satu file audio di `sumber`, itu dipakai; kalau tidak ada sound sama sekali, pola ketukan dari `bpm` (default 120 + peringatan) dan **tidak ada** klip musik (sound tren dipasang tim di TikTok).
  - Sound tim, bukan musik berlisensi; dipasang di track `music` (`media: $sumber:<id>`, `in_ms` = ketukan pertama, volume 1).
  - `ketukan_per_potong: auto`: 1/2/4 ketukan yang paling dekat ±1,8 dtk per orang dan masih 0,9–4 dtk.
  - `durasi` termasuk end card. Video dipotong di ketukan terakhir yang masih muat.
  - `sumber_orang` (keputusan owner PC-R7 opsi A, 15 Nov): per footage atau per shot, `"kreator"` (kreator/model sendiri yang setuju) atau `"umum"` (default, diisi tim). Orang umum hanya dipakai kalau memang memakai produk brand; **tanpa blur wajah**. Tahap 2 (AI ganti pakaian, belum dikerjakan) hanya akan memproses shot `"kreator"`. Field ini ikut di `beatspot.json` per potongan dan per kandidat.
  - Hybrid: `urutan_shot` dipakai lebih dulu sesuai urutan (sisanya otomatis), `kecualikan_shot` tidak dipakai; penggeseran potongan dilakukan di editor.
- Shot: footage dipotong per adegan + saat orang masuk/keluar bingkai, maks 4 dtk. Dipakai hanya shot dengan orang (≥ 50% sampel), tidak buram, tidak beku, bukan wajah dekat orang lewat. Potongan berganti footage (orang beda) kalau bisa; satu shot tidak dipakai dua kali; diambil bagian tengah shot.
- Output: `out/ops.json` (ms-ops/1, `set_canvas` 9:16, `set_brand_logo` (logo kecil sesuai Brand Kit `visual.logo`), `set_loudness`, klip `video` volume 0, `music` sound, end card = klip `broll` aset `visual.penutup` + teks tagline di atasnya; tanpa aset penutup: tagline di 2 dtk terakhir video + `menunggu_u3`), `out/rencana.json` (`beatspot: {bpm, sumber_ketukan, ketukan_per_potong, potongan, end_card_dtk}`), `out/qc_rencana.json` (durasi, potong_di_ketukan ±1 frame, lama_per_orang_1_4_dtk, shot_tidak_berulang, orang_berganti, video_tanpa_celah, klip_min_100ms).
- `out/beatspot.json` (schema `beatspot/1`): `bpm`, `ketukan` (detik timeline), `ketukan_per_potong`, `potongan: [{no, mulai, durasi, shot, footage, in, skor, alasan, sumber_orang}]`, `kandidat: [{id, footage, dari, sampai, orang, framing, skor, dipakai, sumber_orang}]` (untuk tim memilih/mengurutkan lewat `urutan_shot`), `dibuang: [{id, alasan}]`.
- Motion Studio (ucok) perlu: validasi mode `beatspot` di runner U6 + halaman/kartu Beat Spot. Belum ada di app.

## 17. Preset gaya dari hasil belajar (R18, v0.4.0, 15 Nov 2026, venus — owner: "Ya, pasang")
Sumber angka: laporan Hanagaki (85 video Aysilla, `BELAJAR/hanagaki/LAPORAN-HANAGAKI.md`). **Semua field opsional dan aditif**: preset/Brand Kit lama tetap valid; field yang tidak ada = perilaku sekarang. Hybrid: semua hasil tetap bisa diubah di editor.

### 17.1 Field tambahan di `preset.<id>` (BrandPreset)
| Field | Nilai | Dipakai |
|---|---|---|
| `jenis` | `"street_interview"` \| `"test_produk"` \| `"harian_studio"` \| `"beat_spot"` \| `"lain"` | label + bawaan di bawah |
| `caption.y` | 0..1 (pusat caption) | posisi caption kalau tidak bentrok wajah/produk (Generate) |
| `caption.warna`, `caption.outline` | `#rrggbb` | warna caption (default `visual.warna_teks` / `visual.outline`) |
| `caption.kotak` | bool | kotak latar caption |
| `hook.y` | 0..1 (atas panel hook) | posisi awal hook; cek teks bawaan/wajah (§14) tetap boleh menggeser |
| `hook.ukuran` | % tinggi layar per baris (1–8) | ukuran teks hook |
| `hook.baris` | 1–3 | maksimum baris hook |
| `hook.warna` | `#rrggbb` | warna hook |
| `hook.dari_kalimat_kuat` | bool | hook diambil dari kalimat dengan angka/harga/rating/"!" kalau ada; kalau tidak ada → peringatan `jenis: "hook"` |
| `shot.target_dtk`, `shot.maks_dtk` | detik | shot lebih panjang dari `maks_dtk` dipecah dengan punch-in 110 % (efek zoom) atau b-roll |
| `transisi.ganti_orang` | `"potong"` \| `"flash"` | `flash` = transisi flash putih 0,3 dtk saat ganti narasumber/footage |
| `penutup.end_card` | bool | end card wajib (aset `visual.penutup` + `teks.tagline`); kalau aset tidak ada → peringatan `jenis: "penutup"` |
| `beat.tiap_ketukan`, `beat.bpm` | 1/2/4, 60–200 | bawaan Beat Spot (§16) |

### 17.2 Musik atau voice over: pilihan per job (owner 15 Nov: "opsional, tergantung kebutuhan")
- Field `job.json` opsional `audio_pilihan`: `"vo"` (tanpa musik) · `"musik"` (tanpa VO, mis. konten harian studio) · `"keduanya"` (musik di bawah VO, ducking §12.2). Tidak ada = perilaku sekarang (Generate: musik kalau ada aset yang boleh; Batch: tanpa musik).
- Aturan lisensi musik tetap: hanya aset `lisensi_iklan: true` (atau milik brand). Pilihan ini tidak membuka musik berlisensi pihak lain.
- `"musik"`: transkrip lirik lagu tidak boleh dijadikan caption (sejalan §14 R1).

### 17.3 Field tambahan Brand Kit
- `teks.tagline` (teks, mis. "CUCI · JEMUR · LANGSUNG PAKAI") dipakai end card dan Beat Spot.
- `visual.watermark`: `{ teks, y, lebar, opasitas }` opsional. Motion Studio hanya punya satu track `text`, jadi watermark teks mengisi celah di antara hook/CTA/disclaimer (hilang saat teks lain tampil). Untuk watermark yang selalu tampil, pakai logo Brand Kit (`set_brand_logo`).
- Video iklan (Generate, venus): `caption.y` jadi posisi pilihan pertama (wajah/produk tetap dihindari), `hook.y` dicoba paling dulu oleh cek §14, `hook.ukuran`/`warna`, `caption.warna`/`kotak`, `shot.maks_dtk` = punch-in 110 % bergantian di klip yang lebih panjang (skala sebelumnya dipulihkan), `penutup.end_card` → peringatan `jenis: "penutup"` kalau aset tidak ada, `audio_pilihan: "vo"` → tanpa musik.

### 17.4 Preset contoh Aysilla (diisi tim lewat menu Brand)
`aysilla-interview` (street_interview: caption.y 0.76, warna #F5EFA0, maks_kata 4, hook.y 0.18 ukuran 4.5, shot 1.9/3.5, transisi flash, durasi 40–55) · `aysilla-test-produk` (caption.y 0.45, 2 baris, shot 1.6) · `aysilla-harian` (hook.y 0.54 ukuran 3.4 baris 2 putih, shot 1.2/3.5, durasi 13–18) · `aysilla-beatspot` (beat 4 ketukan, 120 BPM, durasi 15–18, hanya watermark).

### 17.5 Catatan implementasi Batch Remix & Beat Spot (yuki, R18)
- Preset aktif = `brand_kit.json → preset[job.preset]` (`pipeline/batch/gaya.py`). Tanpa `job.preset` atau field = perilaku lama (dites: ops identik).
- `caption.outline`: Motion Studio hanya punya outline gelap (boolean), jadi warna outline preset belum dipakai. `caption.kotak: true` = latar `latar_gelap` 60 %.
- `hook.ukuran` (% tinggi per baris) diubah ke `style.size` (% sisi pendek): ×16/9 di 9:16. `hook.baris` membatasi ±3 kata per baris.
- `shot.maks_dtk`: potongan panjang dipecah (min 1 dtk per pecahan) di ms bulat, waktu sumber tetap sinkron. Pecahan berselang diberi punch-in `zoom` 1,1 (cut) di track `effects`; zoom halus yang bentrok dibuang, zoom-through hanya di potongan asli.
- `transisi.ganti_orang: "flash"` = `transition: {type: "flash", ms: 300}` (§12.1) di klip video yang footage-nya beda dari klip sebelumnya. Tidak ada flash di pecahan shot yang sama.
- End card Batch: klip `broll` aset penutup + tagline sesudah video, musik ikut diperpanjang. Tanpa aset: peringatan `jenis: "penutup"` + `menunggu_u3`.
- `visual.watermark`: track `text` tidak boleh tumpang tindih, jadi watermark mengisi sela di antara hook/CTA/tagline. `opasitas` belum didukung (peringatan `info`).
- `audio_pilihan` Batch: `"vo"` = tanpa musik; `"musik"` = tanpa klip VO dan tanpa caption ucapan (susunan gambar tetap mengikuti kalimat); `"keduanya"` = musik + VO + `set_ducking` 0,3. `"musik"`/`"keduanya"` tanpa musik yang boleh dipakai = ditolak (kode 2).
- Beat Spot: bawaan `beat.bpm` / `beat.tiap_ketukan` dari preset kalau `job.beatspot` tidak mengisinya; tagline dari `teks.tagline`; watermark seperti di atas; preset `jenis: "beat_spot"` + watermark = logo tidak dipasang ("hanya watermark", §17.4). `audio_pilihan: "vo"` = sound tidak dipasang (pola BPM).
- Progres JSON-lines Batch / Pisah / Beat Spot kini ditulis UTF-8 (di Windows sebelumnya cp1252, karakter seperti "·" rusak di app).

## 18. Visual Tools AI lokal (R24, v0.4.1, 16 Nov 2026, yuki — owner: "Ya, bagikan") — DRAF
Semua model jalan di PC sendiri, tanpa API berbayar. Hasil AI selalu **usulan** (`"usulan": true`): app menampilkannya sebagai keyframe/jalur yang bisa diubah, dimatikan, atau dihapus manual (hybrid). Job berat jalan dengan prioritas Idle dan maksimal 2 pekerja. Kode ada di `pipeline/visual/`. Python vision = venv terpisah `D:\VIBECODING\tools\visual-venv` (override `MOTION_VISUAL_PY`) supaya OpenCV demucs-venv tidak bentrok. Status: format 18.1–18.2 sudah ada dan dites; 18.3–18.6 menunggu OK instalasi dari venus.

### 18.0 Aturan wajib: lisensi, cache, beban
Sumber: cek sukma 16 Nov, Motion-studio `docs/R23-R24-LISENSI-KAPASITAS-2026-11-16.md`. Aturan ini ditegakkan di `pipeline/visual/beban.py` dan dites di `AturanBeban`.

1. **Model hapus latar** selalu disebut eksplisit dan harus ada di daftar putih:
   - `birefnet-general-lite` (MIT, bawaan kita);
   - `isnet-general-use`, `u2net`, `u2netp`, `u2net_human_seg`, `silueta` (semuanya Apache-2.0).
   
   Model lain ditolak dengan kode 2. Bawaan rembg (bria-rmbg) non-komersial, jadi **dilarang**. Backend cloud (withoutbg, atlascloud) juga tidak dipakai.
2. **Cache model di D:**, tidak di C:
   - `U2NET_HOME` = `D:\VIBECODING\tools\models`
   - `HF_HOME` = `…\models\hf`
   - Model MediaPipe dipanggil dengan path file eksplisit dari folder yang sama.
   - Folder bisa diganti lewat `MOTION_MODELS_DIR`.
3. **Beban:**
   - Hanya **satu** job AI berat sekaligus di seluruh mesin. Kuncinya file global `…\modelsi-berat.lock` (override `MOTION_AI_LOCK`); kunci dari pid yang sudah mati diambil alih. Whisper ikut aturan ini bila pemanggilnya memakai `kunci_ai`.
   - Prioritas Idle, maksimal 4 thread, maksimal 2 pekerja.
   - Kalau RAM bebas kurang dari 3 GB, job menunggu dengan progres `{"tahap":"menunggu"}`. Kalau sedang antre di belakang job lain: `{"tahap":"antre"}`.
   - Klip video untuk hapus latar atau perjelas maksimal **15 detik**. Lebih dari itu ditolak dengan kode 2.
   - Perkiraan waktu dikirim sebelum mulai: `{"tahap":…, "perkiraan_dtk": N}`. Real-ESRGAN butuh sekitar 15–45 menit per 30 detik video, jadi hanya untuk klip pendek.
   - BiRefNet hanya di CPU (onnxruntime), tanpa torch.
4. AutoFlip (legacy, tidak tersedia di pip) tidak dipakai. Reframe memakai implementasi sendiri (§18.2).

### 18.1 Jalur posisi `jalur-posisi/1` (R24a wajah/objek, R24c pelacakan)
Koordinat = pecahan frame (0..1), kotak kiri-atas + lebar/tinggi, `t` dalam detik (naik).
```json
{"schema":"jalur-posisi/1","video":"konten/…/a.mp4","lebar":1920,"tinggi":1080,"fps":30,"durasi":12.4,
 "sumber":"mediapipe-wajah|mediapipe-objek|lacak-csrt|lacak-kcf|manual","usulan":true,
 "jalur":[{"id":"wajah-1","jenis":"wajah|objek|lacak","label":"face","titik":[{"t":0.0,"x":0.31,"y":0.18,"w":0.22,"h":0.12,"skor":0.93}]}]}
```
- Celah lebih dari 0,5 detik di antara dua titik = subjek hilang. Pada celah itu jalur tidak diinterpolasi, jadi app tidak menempelkan apa pun.
- Subjek utama = luas × skor × lama tampil. Wajah dibobot ×2.

### 18.2 Reframe `reframe/1` (R24b, pola AutoFlip)
Hasilnya keyframe jendela crop, **bukan** video jadi.
```json
{"schema":"reframe/1","rasio":"9:16","lebar_crop":0.3164,"tinggi_crop":1.0,"mode":"diam|ikut|tengah",
 "subjek":"wajah-1","usulan":true,"keyframe":[{"t":0.0,"x":0.41,"y":0.0}]}
```
- `x`, `y` = kiri-atas jendela, pecahan frame sumber. Di antara keyframe dipakai interpolasi linear; sebelum keyframe pertama dan sesudah keyframe terakhir posisinya tetap.
- `mode`:
  - `diam`: subjek muat di satu jendela, jadi cukup 1 keyframe.
  - `ikut`: kamera mengikuti subjek dengan zona mati 0,06, pan maksimal 0,30 frame/detik, dan penghalusan 0,6 detik. Keyframe disederhanakan dengan RDP, toleransi 0,004.
  - `tengah`: tidak ada subjek, atau sumber sudah memiliki rasio target.
- **Ke keyframe app** (`keyframes.ts`: x, y = geser dari tengah −1..1, scale 0.1..4, `at_ms` = waktu di dalam klip). Fungsinya `reframe.ke_keyframe_app(rf, sumber=(sw,sh), kanvas=(W,H), fit, awal_ms)`.
  - Render app: sumber di-fit ke kanvas dulu, lalu di-scale di sekitar tengah dan digeser x·W, y·H. Faktor fit:
    - `f = min(W/sw, H/sh)` untuk fit pas, yaitu contain / warna / blur;
    - `f = max(W/sw, H/sh)` untuk fit `isi` (cover).
  - Dengan `cw = lebar_crop` dan `ch = tinggi_crop`:
    - `scale = W / (sw·f·cw)`
    - `x_app = (0.5 − (x + cw/2)) / cw`
    - `y_app = (0.5 − (y + ch/2)) / ch`
    - `at_ms = t·1000 − titik masuk klip (ms sumber)`
    - `ease = linear`
  - x_app tidak bergantung pada fit.
  - |x_app| dipotong ke 1. Di pinggir frame nilai aslinya bisa 1,08. Jendela jadi bergeser sedikit ke tengah, tetapi gambar tetap penuh tanpa bolong hitam.
  - Paling banyak 20 keyframe (`MAX_KEYFRAMES`). Kalau lebih, RDP dilonggarkan.
  - Contoh 1920×1080 → 1080×1920, `cw` = 0,3164:
    - fit `isi`, crop di tengah: x 0, scale 1 (identitas);
    - fit pas, crop x = 0,6: scale 3,16, x_app −1,0 (dipotong dari −1,08).
  - Tes `KeyframeApp` mensimulasikan transform render app. Hasilnya: sudut jendela crop jatuh di sudut kanvas, meleset maksimal 3 px.

### 18.3 Perintah (rencana)
`python pipeline/visual/reframe.py <jalur.json> <keluar.json> [--rasio 9:16] [--subjek id]` sudah ada. Perintah berikut menyusul sesudah OK instalasi:
- `deteksi` (R24a) → jalur-posisi
- `lacak` (R24c, kotak awal dari user)
- `hapus_latar` (R24d, BiRefNet-lite lewat rembg; RMBG BRIA **tidak** dipakai karena non-komersial) → PNG/WebM dengan alpha
- `perjelas` (R24e, Real-ESRGAN ncnn-vulkan)
- `tts` (R24f, `pipeline/tts_windows.ps1`, suara Windows offline)

Semua perintah itu menulis progres JSON-lines dalam UTF-8.

### 18.4 TTS voice over `tts/1` (R24f) — sudah jalan
`engine tts <job_dir>`:
- Masukan: `job.json` → `"tts": {"kalimat": ["…", "…"], "suara": "Andika", "kecepatan": 1.0}`. `"teks": "…"` boleh dipakai sebagai ganti `kalimat`.
- Keluaran, hanya di dalam job_dir:
  - `out/vo/01.wav`, `02.wav`, …
  - `out/tts.json` = `{"schema":"tts/1","status":"selesai|ditolak","suara","kecepatan","usulan":true,"file":[{"no":1,"teks","file":"out/vo/01.wav","durasi":1.84}],"total_durasi","alasan"?}`
- Kode keluar:
  - 2 (ditolak) bila teks kosong, lebih dari 60 kalimat, lebih dari 1000 huruf per kalimat, kecepatan di luar 0,5–2,0, suara tidak terpasang, atau bukan Windows;
  - 1 bila gagal teknis.
- Suara offline dari Windows OneCore. Di PC kantor yang ada: Andika (id-ID), dan suara Inggris David, Zira, Mark, George, Susan, Hazel.
- Prioritas proses Idle. Skrip `tts_windows.ps1` diambil dari folder kode (rilis). Tidak ada yang ditulis ke folder data. App yang memindahkan WAV ke proyek sebagai usulan di track audio.
