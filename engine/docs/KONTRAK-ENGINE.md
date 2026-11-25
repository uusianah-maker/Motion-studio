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
Semua model jalan di PC sendiri, tanpa API berbayar. Hasil AI selalu **usulan** (`"usulan": true`): app menampilkannya sebagai keyframe/jalur yang bisa diubah, dimatikan, atau dihapus manual (hybrid). Job berat jalan dengan prioritas Idle dan maksimal 2 pekerja. Kode ada di `pipeline/visual/`. Python vision = venv terpisah `<TOOLS>\visual-venv` (override `MOTION_VISUAL_PY`) supaya OpenCV demucs-venv tidak bentrok. Status: format 18.1–18.2 sudah ada dan dites; 18.3–18.6 menunggu OK instalasi dari venus.

### 18.0 Aturan wajib: lisensi, cache, beban
> `<TOOLS>` = folder alat bersama: env `MOTION_TOOLS_DIR`, bawaannya `<DATA>/../tools` (di PC kantor `D:` …`\tools`). Isinya `visual-venv`, `demucs-venv`, `models`, dan `realesrgan`. Kode tidak berisi path absolut karena repo bersifat publik.

Sumber: cek sukma 16 Nov, Motion-studio `docs/R23-R24-LISENSI-KAPASITAS-2026-11-16.md`. Aturan ini ditegakkan di `pipeline/visual/beban.py` dan dites di `AturanBeban`.

1. **Model hapus latar** selalu disebut eksplisit dan harus ada di daftar putih:
   - `birefnet-general-lite` (MIT, bawaan kita);
   - `isnet-general-use`, `u2net`, `u2netp`, `u2net_human_seg`, `silueta` (semuanya Apache-2.0).
   
   Model lain ditolak dengan kode 2. Bawaan rembg (bria-rmbg) non-komersial, jadi **dilarang**. Backend cloud (withoutbg, atlascloud) juga tidak dipakai.
2. **Cache model di D:**, tidak di C:
   - `U2NET_HOME` = `<TOOLS>\models`
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
> Diperluas di **§21** (R34 Suara dari Teks): daftar suara, pelafalan, gabungan, cap waktu kata, -16 LUFS.
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

### 18.5 Venv & model terpasang (16 Nov 2026, OK venus)
- **visual-venv**: `<TOOLS>\visual-venv`, Python 3.12.5, ukuran 730 MB.
  - Versi dikunci di `pipeline/visual/requirements-visual.txt`: mediapipe 1.2.3, opencv-contrib-python 5.0.0.93 (dengan CSRT/KCF), rembg 2.0.87, onnxruntime 1.32.0 CPU. Tanpa torch.
  - `.venv` dan `demucs-venv` tidak berubah: `pip freeze` sebelum dan sesudah instalasi identik.
- **Model**, di `<TOOLS>\models`:

| File | Sumber | Lisensi | SHA256 |
|---|---|---|---|
| `blaze_face_short_range.tflite` (0,23 MB) | storage.googleapis.com/mediapipe-models …/float16/1 | Apache-2.0 | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `efficientdet_lite0_int8.tflite` (4,6 MB) | storage.googleapis.com/mediapipe-models …/int8/1 | Apache-2.0 | `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb` |
| `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx` (224 MB) = rembg `birefnet-general-lite` | GitHub ZhengPeng7/BiRefNet rilis v1 | MIT | `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333` |
| `u2net_human_seg.onnx` (176 MB) — terpasang, **tidak jadi bawaan** (ikut menghapus produk yang dipegang) | GitHub danielgatis/rembg rilis v0.0.0 (distribusi ONNX resmi, OK venus) | Apache-2.0 | `01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c` |
| `isnet-general-use.onnx` (179 MB) — bawaan video | GitHub danielgatis/rembg rilis v0.0.0 | Apache-2.0 | `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a` |
| `realesrgan-ncnn-vulkan-20220424-windows.zip` (45,5 MB) — diekstrak ke `realesrgan\` (§18.9) | GitHub xinntao/Real-ESRGAN rilis v0.2.5.0 | BSD-3 (model) + MIT (ncnn-vulkan) + BSD-3 (ncnn); zip tanpa LICENSE | `abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d` |

### 18.6 Deteksi wajah & objek (R24a) — sudah jalan
Perintah: `<visual-venv>\Scripts\python pipeline/visual/deteksi.py <video> <keluar.json> [--jenis wajah,objek] [--hz 10] [--label person,handbag,…]`. Hasilnya jalur-posisi/1 (§18.1).
- **Wajah**: FaceDetector dijalankan di seluruh frame, lalu sekali lagi di potongan kepala tiap orang. Model short-range hanya akurat untuk wajah yang dekat kamera; dengan potongan ini wajah ikut terbesar. Hasil keduanya digabung dengan NMS.
  - Uji IN17 (576×1024, 12,9 dtk): wajah terdeteksi di 82/129 sampel dengan skor rata-rata ±0,9. Tanpa potongan kepala hanya 5 sampel.
- **Objek**: ObjectDetector efficientdet_lite0, label COCO. Bawaannya `person`.
- **Penggabungan jalur**:
  - Deteksi dipasangkan dengan jalur lama lewat IoU. Kalau gerakannya cepat, dipakai pusat kotak yang dekat dengan ukuran mirip.
  - Subjek yang hilang sampai 1,5 dtk tetap memakai id yang sama, tetapi celahnya tidak diinterpolasi.
  - Jalur yang hanya muncul di 1 sampel dibuang.
- **Waktu**: ±6 dtk untuk klip 13 dtk di CPU, prioritas Idle.

### 18.7 Pelacakan gerak (R24c) — sudah jalan
Perintah: `<visual-venv>\Scripts\python pipeline/visual/lacak.py <video> <keluar.json> --kotak x,y,w,h [--mulai dtk] [--sampai dtk] [--alat csrt|kcf] [--hz 15]`.
- **Masukan**: kotak berupa pecahan frame pada detik `--mulai`, digambar user di app.
- **Hasil**: jalur-posisi/1 dengan satu jalur `lacak-1` (`jenis: "lacak"`), plus `berhenti`: `"selesai"` atau `"objek hilang"`.
- **Cara kerja**: tracker berjalan di setiap frame, dengan frame diperkecil sampai sisi panjangnya maksimal 640 px.
  - Saat objek lepas, celah tidak ditulis.
  - Kalau objek hilang lebih dari 2 dtk, pelacakan berhenti. User bisa memilih kotak lagi dari titik itu.
- **CSRT** adalah bawaan dan lebih tahan perubahan ukuran. **KCF** lebih cepat.
- **Uji**:
  - Wajah IN17: galat pusat ±1% frame dibanding detektor (CSRT 0,011, KCF 0,0065). Objek lepas di detik ke-4–5 saat subjek berbalik. Waktu proses CSRT 7 dtk, KCF 5 dtk.
  - Tes sintetis `Lacak`: CSRT dan KCF sama-sama mengikuti kotak bergerak dengan galat ≤3%.
- **Pemakaian di app**: hasil ini untuk menempelkan teks, stiker, atau blur yang ikut objek. Rumus posisinya sama dengan §18.2: pusat kotak dikonversi lewat x_app/y_app. Tampilannya diserahkan ke ucok.

### 18.8 Hapus latar (R24d) — sudah jalan
Perintah: `<visual-venv>\Scripts\python pipeline/visual/hapus_latar.py <masuk> <folder_keluar> [--model birefnet-general-lite] [--fps 10]`.
- **Gambar** (.jpg/.png/.webp/.bmp): `<nama>.png` (RGBA) dan `<nama>-masker.png`.
- **Video** (maksimal 15 dtk; topeng dibuat per frame pada `--fps` 1..30, bawaan 10):
  - `<nama>-alpha.webm`: VP9 dengan alpha (yuva420p, `alpha_mode=1`), untuk layer di editor;
  - `<nama>-masker.mp4`: abu-abu, putih = subjek, untuk `alphamerge` di render.
- **Laporan**: `<folder_keluar>/hapus_latar.json`, berisi `{"schema":"hapus-latar/1","status":"selesai|ditolak","usulan":true,"model","lisensi","jenis","file","masker",…}`. Kode keluar 2 untuk ditolak (model di luar daftar putih, klip lebih dari 15 dtk, fps di luar batas), 1 untuk gagal teknis.
- **Tanpa unduhan dari rembg.** rembg ternyata mengunduh model dari mirror danielgatis, bukan dari sumber resmi. Satu kali sempat terunduh saat uji coba; filenya identik (SHA sama) dan sudah dihapus. Karena itu inferensi BiRefNet ditulis langsung dengan onnxruntime dan file resmi di §18.5: input tetap 1024×1024, normalisasi ImageNet, lalu sigmoid. Model lain di daftar putih belum dipasang dan ditolak sampai unduhannya mendapat OK.
- **Model (16 Nov, OK venus)**:

| Model | Untuk | Kecepatan per frame | Catatan |
|---|---|---|---|
| `isnet-general-use` | bawaan **video** | ±1,3 dtk | Topengnya dipertegas (0,15–0,55 → 0–1) karena kain polos sempat setengah transparan; sebagian latar bisa ikut terbawa. Video 15 dtk @10 fps ≈ **3,5 menit** (uji 2 dtk: 27 dtk). |
| `birefnet-general-lite` | bawaan **gambar**, opsi "kualitas tinggi" untuk klip sangat pendek | ±13 dtk | — |
| `u2net_human_seg` | — | ±0,45 dtk | **Tidak dipakai sebagai bawaan**: celana yang dipegang ikut terhapus. |

- **Kecepatan BiRefNet di CPU PC kantor: ±13 dtk per frame.**
  - Satu gambar butuh ±13 dtk.
  - Video 15 dtk pada 10 fps (150 frame) butuh ±33 menit. Pada 5 fps, ±17 menit.
  - Perkiraan waktu diukur dari frame pertama, lalu dikirim lewat `perkiraan_dtk`.
  - Hasil uji: orang, celana, dan gantungan terpisah rapi.

## 19. SFX lebih banyak (R29, v0.4.2, 16 Nov 2026, yuki — owner: "SFX itu banyak, kenapa tidak dipakai?")
Modul `pipeline/sfx_rencana.py` dipakai Generate (`ops.py`, langkah 6b, sesudah efek video) dan Batch Remix (`batch/perencana.py`) dengan aturan yang sama. Modul ini membaca timeline ms-ops/1 yang sudah jadi, lalu **mengganti semua klip track `sfx`**.
- **Penyebab dulu hanya 1 SFX:** bunyi "pop" hanya untuk `kata_kunci` Brand Kit, dan di Aysilla daftar itu masih kosong. Akibatnya cuma whoosh di hook yang terpasang.
- **Kejadian**, urut dari prioritas tertinggi:

| Kejadian | SFX |
|---|---|
| hook muncul | muncul |
| CTA | ding |
| kata harga, yaitu `rp…`, `…rb/k/ribu/jt/%`, diskon, promo, gratis, ongkir, harga, murah, hemat, cuma, cashback, potongan, sale | harga |
| riser 0,9 dtk sebelum hook (kalau ada ruang) atau sebelum CTA (kepadatan sedang/ramai) | riser; hanya dipakai bersama pasangannya |
| titik potong klip video, efek `zoom_through`/`flash`/zoom `cut` (punch-in), transisi | whoosh |
| kata yang di-highlight (kata kunci/angka) | pop |
| halaman subtitle baru | pengisi, pop pelan, disebar merata |

- **Kepadatan:** field preset baru `sfx.kepadatan`, opsional, bawaannya `"sedang"`.

| Kepadatan | Jarak minimal antar SFX | Jumlah maksimal |
|---|---|---|
| `"tanpa"` | — | 0 |
| `"sedikit"` | 3 dtk | 1 per 6 dtk |
| `"sedang"` | 1,5 dtk | ±1 per 3 dtk |
| `"ramai"` | 1 dtk | 1 per 2 dtk |

  Di setiap jendela sepanjang batas jumlah, paling banyak 2 SFX. Whoosh paling banyak separuh jatah dan dipilih tersebar.
- **Pemilihan bunyi:**
  - Kategori Kenney (switch/minimize/maximize/…) dipilih berselang-seling, dengan cadangan tag mesin (`transisi`, `kata-kunci`, `teks-muncul`, `penutup`) untuk brand tanpa Kenney.
  - File yang sama tidak dipakai lagi dalam 3 SFX terakhir.
  - Bunyi negatif (error/glitch/scratch/question/back/click/tick) tidak dipakai.
  - `sfx_dilarang` dan `lisensi_iklan: false` dihormati.
  - Panjang klip = panjang file − `SISA_MS`, supaya tidak dibuang oleh `jaga_durasi`.
- **Volume:** muncul 0,35 · ding/harga 0,4 · whoosh/pop 0,3 · pengisi 0,22 · riser 0,25. Semuanya di bawah VO (1,0).
- **Kalau Library brand kosong:** dipakai bunyi bawaan mesin `$sfx:pop` / `$sfx:whoosh`.
- **Laporan:** `rencana.audio.sfx_rencana` = `{kepadatan, jumlah, berbeda, detail:[{detik, jenis, alasan, media}], bawaan_mesin}`. Di Batch: `varian.sfx_rencana`.
- **Hybrid:** semua SFX adalah klip biasa di track `sfx`, jadi bisa dihapus, digeser, atau diganti di editor.
- **Catatan Library Kenney:** tidak ada bunyi kasir atau riser asli. "ding/harga" memakai confirmation/glass/bong, "riser" memakai maximize/scroll. Kalau owner mau bunyi cash/riser sungguhan, perlu aset baru (CC0) di Library.
- **Uji (salinan job, validator Motion Studio OK):**
  - Generate AYS-20261116-002 (21 dtk): 1 → 8 SFX, 8 file berbeda.
  - Generate AYS-20261116-001 (5,4 dtk): 1 → 2 SFX (hook + "promo").
  - Batch 5 varian (21–63 dtk): 7–20 SFX per varian, 6–10 kategori bunyi.

## 20. Typo subtitle: kosakata, kamus, belajar dari koreksi (R30, v0.4.3, 16 Nov 2026, yuki)
### 20.1 Kosakata & kamus Brand Kit (R30a)
- **Generate sudah memakainya:**
  - `teks.kosakata_whisper` dikirim ke Whisper sebagai `initial_prompt` + `hotwords` (`transcribe.py --brandkit`).
  - `teks.kamus` dipakai untuk koreksi otomatis sesudah transkrip (`apply_kamus`).
  - Batch juga menerapkan kamus pada VO (`batch/vo.py`).
- **Temuan 16 Nov:** di Brand Kit Aysilla di Motion Studio, `kosakata_whisper` = [] dan `kamus` = {}. Padahal file lama `brandkit/aysilla.json` di repo berisi 28 istilah dan 21 koreksi, termasuk "ekot/cekot → checkout", "lus/los → loose", "icila factory → Aysilla Factory". Isi itu belum pernah dipindahkan. Tim perlu mengisinya lewat menu Brand.
- **Shot Library Batch** dulu mentranskrip memakai `brandkit/aysilla.json` dari repo. **Sudah diperbaiki (multi-brand)**: `engine pisah` mengirim `brand_kit.json` milik job ke `shotlib.py --brandkit`. File repo hanya dipakai bila dijalankan lewat CLI tanpa job. Transkrip yang sudah ada tidak diulang.

### 20.2 Usulan kamus dari koreksi editor (R30b) — `kamus-usulan/1` — ALAT BANTU
> **Jalur resmi = core `kamusBelajar.ts` (app, venus cbbcc41)**. App yang memegang `belajar.jsonl` dan menambahkan pasangan "otomatis" ke `teks.kamus` di setiap job. `kamus_belajar.py` hanya alat CLI dan referensi; mesin **tidak** memanggilnya. R30 dilanjutkan oleh venus sejak 16 Nov.
Perintah: `python pipeline/kamus_belajar.py <.motionstudio/brands/<brand_id>/belajar.jsonl> [--brand-kit brand_kit.json] [--min 2]`. Hasilnya satu JSON di stdout.
```json
{"schema":"kamus-usulan/1","minimal":2,"koreksi_kata":4,
 "usulan":[{"salah":"cana","benar":"celana","jumlah":2,"proyek":2,"contoh":[{"sebelum":"mau punya cana","sesudah":"mau punya celana"}],
            "periksa":false,"kosakata_baru":["celana"]}],
 "pantau":[…], "sudah_di_kamus":[…]}
```
- **Sumber:** catatan R9 dengan `jenis: "koreksi"`, `bagian: "kata"`.
- **Pencocokan:** teks dibandingkan per kata (difflib). Hanya **penggantian** 1–3 kata yang diambil. Beda huruf besar/kecil, tanda baca, atau kata yang hanya ditambah/dihapus diabaikan.
- **Pembagian:** pasangan yang muncul ≥ `minimal` kali masuk `usulan`. Yang muncul sekali masuk `pantau`. Yang sudah ada di kamus masuk `sudah_di_kamus`.
- **`periksa: true`** berarti berbahaya kalau diterapkan secara global. Ini terjadi bila kata salahnya ≤3 huruf, atau kata itu di koreksi lain justru dibiarkan tim.
- **Hybrid:**
  - App (ucok) menampilkan usulan di menu Brand.
  - Tim menyetujui dengan satu klik. App lalu menyimpan `salah → benar` ke `teks.kamus` dan `kosakata_baru` ke `teks.kosakata_whisper`.
  - Mesin tidak pernah menulis ke Brand Kit.
- **Data nyata Aysilla, 16 Nov:** 4 koreksi kata. Semua pasangan masih berstatus pantau: "cana → celana", "icy love → Aysilla", "janganlah → Join Live". Perubahan "sekarang → Sekarang" diabaikan.

### 18.9 Perjelas / upscale (R24e) — sudah jalan
Perintah: `<visual-venv>\Scripts\python pipeline/visual/perjelas.py <masuk> <folder_keluar> [--mode cepat|kualitas] [--skala 2|3|4] [--sisi 1920]`.
- **Alat**: `<TOOLS>\realesrgan\realesrgan-ncnn-vulkan.exe` (override `MOTION_REALESRGAN`), berjalan di GPU Vulkan.
  - Lisensi: exe MIT, model BSD-3, ncnn BSD-3. Teks lisensinya tersimpan di `LICENSES\`.
  - `vcomp140d.dll` tidak didistribusikan.
- **Mode**:
  - `kualitas` = realesrgan-x4plus, hanya x4. Bawaan untuk gambar.
  - `cepat` = realesr-animevideov3, x2/x3/x4. Bawaan untuk video.
- **Hasil**:
  - Gambar → `<nama>-hd.png`, sisi panjang maksimal 4096.
  - Video (maksimal 15 dtk) → `<nama>-hd.mp4` (H.264 CRF 18, audio asli disalin), sisi panjang maksimal 1920.
  - Laporan `perjelas.json` = `{"schema":"perjelas/1","status","usulan":true,"mode","model","skala","dari":[w,h],"jadi":[w,h],…}`. Kode keluar 2 untuk ditolak.
- **Waktu nyata** di PC kantor (GTX 1650, prioritas Idle, tile 128):
  - Gambar 576×1024 dengan mode kualitas → 2304×4096 dalam 15 dtk.
  - Video 2 dtk (60 frame) dengan mode cepat x2 → 1080×1920 dalam **30 dtk** (±0,5 dtk/frame). Klip 15 dtk ≈ 4 menit.
  - Mode kualitas di video ±13 dtk/frame, sehingga klip 15 dtk ≈ 100 menit. Hanya untuk klip yang sangat pendek.
  - Perkiraan waktu diukur dari frame pertama; perkiraan ini sedikit berlebih karena sudah termasuk waktu memuat model.
- **Catatan kualitas**: mode cepat menajamkan mata, alis, dan kain, tetapi kulit agak dihaluskan karena modelnya dilatih untuk animasi. Mode kualitas lebih natural.
- **Bug yang sudah diperbaiki saat uji**: stderr exe sempat dialirkan ke pipe yang tidak dibaca, sehingga proses tertahan dan butuh ±50 dtk/frame. Sekarang stderr ditulis ke file log.

### 18.10 Perintah `engine visual <job_dir>` — satu pintu (OK venus 16 Nov)
Pengganti rencana §18.3. Prosesnya berjalan di visual-venv: `MOTION_VISUAL_PY`, bawaannya `<TOOLS>/visual-venv/Scripts/python.exe`. Polanya sama dengan `tts`, dan juga jalan dari folder rilis (R20).
```json
{"schema":"engine-job/1","visual":{"alat":"deteksi|reframe|lacak|hapus_latar|perjelas","masuk":"konten/…/a.mp4", …}}
```
`masuk` boleh relatif ke folder DATA atau absolut.

| `alat` | Parameter (opsional kecuali ditandai) | Hasil di `out/` |
|---|---|---|
| `deteksi` | `jenis` ["wajah","objek"], `hz` 10, `label` ["person"] | `jalur.json` (§18.1) |
| `reframe` | `jalur` (bawaan `out/jalur.json`), `rasio` "9:16", `subjek`; `kanvas` [W,H] + `fit` "pas"\|"isi" + `awal_ms` → ditambah `keyframe_app` siap pakai | `reframe.json` (§18.2) |
| `lacak` | **`kotak` [x,y,w,h]**, `mulai`, `sampai`, `metode` "csrt"\|"kcf", `hz` 15 | `lacak.json` (§18.7) |
| `hapus_latar` | `model`, `fps` 10 | `hapus_latar/` (§18.8) |
| `perjelas` | `mode`, `skala`, `sisi` | `perjelas/` (§18.9) |

- **Progres**: JSON-lines dari alatnya masing-masing.
- **Kode keluar**: 0 selesai · 2 ditolak (`out/visual.json` berisi alasannya bila job tidak sah) · 1 gagal teknis.
- **Tes**: `PerintahVisual` di test_engine menjalankan deteksi lalu reframe + keyframe_app dari salinan folder rilis dengan folder data terpisah. Folder data tidak ditulisi.

### 18.11 Posisi caption memakai MediaPipe (R24a, OK venus 16 Nov)
`posisi_caption.posisi_otomatis` sekarang mendeteksi wajah lewat `visual/deteksi.py --jenis wajah` (visual-venv), memakai titik sampel yang sama seperti sebelumnya (1/dtk, maksimal 90).
- **Cadangan Haar** dipakai bila visual-venv tidak ada, deteksi gagal, prosesnya lebih dari 120 dtk (misalnya antre kunci AI), atau env `MOTION_POSISI_HAAR=1` diisi.
- **Laporan**: `posisiCaption.deteksi` = `"mediapipe"` atau `"haar"`.
- **Uji 3 klip winning**:
  - IN17: wajah terdeteksi di 69% frame dengan MediaPipe, 54% dengan Haar.
  - IN1: 94% (MediaPipe) dan 76% (Haar).
  - IN21 (celana di lantai, tanpa orang): Haar **salah mengira lipatan kain sebagai wajah** dan memindahkan caption ke 0,42. MediaPipe benar: 0 wajah, caption tetap di 0,72.
- **Waktu**: ±2,3 dtk per klip, dibanding ±0,7 dtk dengan Haar.
- test_posisi_caption tetap lulus.

## 21. Suara dari Teks — `engine tts` diperluas (R34, v0.4.4, 16 Nov 2026, yuki; app: ucok)
Menggantikan §18.4. Semua field baru bersifat aditif, jadi job tts/1 lama tetap jalan (default: jeda 300 ms, -16 LUFS).

**Masukan** `job.json → tts`:
```json
{"kalimat":["Halo kak, ini Loose Pants.","Harganya cuma 99 ribu!"], "suara":"windows:Andika", "kecepatan":1.0,
 "jeda_ms":300, "pelafalan":{"Loose Pants":"lus pens"}, "lufs":-16}
```
- `teks` boleh dipakai sebagai ganti `kalimat`.
- `suara` = id dari daftar suara. `"Andika"` tanpa awalan berarti `windows:Andika`.
- Batas nilai: kecepatan 0,5–2,0; jeda 0–3000 ms; lufs -30..-8; maksimal 60 kalimat; maksimal 1000 huruf per kalimat.
- Nilai di luar batas atau backend yang tidak ada menghasilkan kode 2 (ditolak).

**Daftar suara**: `{"tts":{"daftar_suara":true}}` → `out/tts.json` = `{"schema":"tts/1","status":"selesai","suara":[{"id":"windows:Andika","nama":"Microsoft Andika","bahasa":"id-ID","gender":"Male","backend":"windows"}, …]}`. Di PC kantor tersedia Andika (id-ID) dan suara Inggris David, Zira, Mark, George, Susan, Hazel.

**Kamus pelafalan per brand**: field Brand Kit baru `teks.pelafalan` {tulisan: ucapan}, digabung dengan `tts.pelafalan` dari job (job yang menang).
- Frasa terpanjang dicocokkan lebih dulu (maksimal 4 kata), tidak peka huruf besar/kecil maupun tanda baca. Tanda baca di ujung kata tetap ikut, supaya intonasi terjaga.
- Yang berubah hanya ucapan. `teks` dan `kata[].teks` tetap memakai tulisan asli, untuk subtitle.

**Keluaran** (hanya di dalam job_dir):
- `out/vo/01.wav …` per kalimat, ditambah `out/vo/gabungan.wav` (kalimat + jeda).
- Format WAV 48 kHz mono 16-bit.
- Semua file memakai **satu gain** yang sama, sehingga gabungan = target LUFS. Limiter di -1 dBTP. Hasil uji: -16,4 LUFS, -1,0 dBTP.
```json
{"schema":"tts/1","status":"selesai","suara":"windows:Andika","backend":"windows","kecepatan":1,"jeda_ms":300,"lufs":-16,"usulan":true,
 "gabungan":{"file":"out/vo/gabungan.wav","durasi":10.33},
 "file":[{"no":1,"teks":"Halo kak, ini Loose Pants.","diucapkan":"Halo kak, ini lus pens.","file":"out/vo/01.wav","durasi":4.13,
          "mulai":0.0,"akhir":4.13,"kata":[{"teks":"Halo","mulai":0.101,"akhir":0.416}, …]}],
 "total_durasi":10.33}
```
- `file[].mulai/akhir` = posisi kalimat di gabungan. `kata[].mulai/akhir` = posisi kata relatif terhadap file kalimatnya. Waktu kata di gabungan = `file.mulai + kata.mulai`.
- **Cap waktu kata tanpa Whisper**: diambil dari batas kata Windows (`IncludeWordBoundaryMetadata`).
  - Windows hanya memberi waktu mulai kata, jadi akhir kata = awal kata berikutnya.
  - Kata terakhir berakhir di akhir audio dikurangi sisa sunyi (maksimal 0,25 dtk).
  - Frasa hasil pelafalan dibagi rata menurut panjang hurufnya.
- Hybrid: VO adalah usulan. App menaruhnya di Media/Aset brand, lalu tim memakai, memotong, atau menggantinya.

**Backend yang bisa ditambah**: `pipeline/tts.py → BACKEND` = {"windows"}.
- Backend baru (TTS neural Indonesia, atau R31 "Suara owner" = TTS lalu dikonversi RVC/OpenVoice) cukup menyediakan `daftar()` dan `ucapkan(item, suara, kecepatan) → batas kata per kalimat`.
- Id suaranya `"<backend>:<nama>"`, misalnya `owner:Suara owner`.
- Format keluaran tetap sama.
- Kalau backend tidak memberi batas kata, waktu kata akan diisi dari perkiraan atau Whisper (menyusul).

**Skrip** `tts_windows.ps1` (tetap kompatibel dengan cara lama):
- `-Daftar -Laporan s.json` untuk daftar suara;
- `-Masuk m.json -Laporan h.json` untuk banyak kalimat dalam satu proses: teks dibaca dari file UTF-8 (aman untuk tanda kutip), hasilnya berisi batas kata.

Proses PowerShell dan ffmpeg berjalan dengan prioritas Idle.

## 22. VO dari Library: suara utama dari "Suara dari Teks" (R34 lanjutan, v0.4.5, 16 Nov 2026, yuki — usul ucok; disetujui venus)
Tujuannya: VO yang sudah ada di Media/Aset brand (jenis `vo`, hasil `engine tts` §21) dipakai sebagai **suara utama** di Video iklan (Generate), Batch Remix, dan Beat Spot. Subtitle diambil dari teks VO yang sudah diketahui, **tanpa Whisper**. Footage dipakai sebagai gambar (b-roll).

### 22.1 Masukan job (aditif; job tanpa `vo` = perilaku lama)
```json
{"vo": {"media": "$vo:vo-ays-20261116-004", "index": "vo_index.json", "suara_footage": "mati", "subtitle": true}}
```
- **`media`**: kunci aset VO.
  - App memetakannya ke path file lewat `refs.json` / `sumber` seperti media lain.
  - Untuk Generate, kunci ini juga dimasukkan ke `sumber` sebagai `{"kunci":"$vo:…","path":…}`.
- **`index`**: nama file di dalam `<job_dir>`.
  - App **menyalin** `.motionstudio/vo/<version>.json` (`vo-index/1`) ke sana. Mesin tidak membaca `.motionstudio`.
  - Isinya `kalimat[]` dengan `mulai/akhir` (detik di file VO) dan `kata[]` (detik, relatif terhadap kalimatnya). Format ini sama dengan §21 `file[]` dan dengan `voText.ts`.
- **`suara_footage`**: `"mati"` (bawaan) | `"pelan"` (suara asli footage dipertahankan di 15 %, misalnya suasana) | `"asli"`.
- **`subtitle`**: bawaan `true`.
- **Ditolak (kode 2)** bila:
  - index tidak ada atau tidak sah (bukan `vo-index/1`, tanpa kalimat, `akhir` > durasi file + 0,1 dtk, lebih dari 60 kalimat);
  - media VO tidak ada;
  - `audio_pilihan: "musik"` dipakai bersama `vo` (bertentangan).

### 22.2 Keluaran (ms-ops/1, sama untuk ketiga mode)
- **Track `audio`**:
  - satu klip VO utuh mulai 0 ms (`in_ms` 0, durasi = durasi VO), volume 1,0;
  - jeda antar kalimat ikut dari file (sudah diatur `jeda_ms` saat TTS).
- **Track `subtitle`**:
  - dari index; satu kalimat dipecah menjadi halaman sesuai aturan caption mode/preset (`caption.maks_kata`, bawaan 3–4 kata);
  - `words` diambil dari `kata[]`, dengan waktu = `kalimat.mulai + kata.mulai`;
  - teks = tulisan asli (pelafalan §21 tidak tampil di layar);
  - kata kunci, angka, dan harga di-highlight seperti biasa;
  - koreksi kamus **tidak** diterapkan karena teksnya sudah benar.
- **Track `video` (footage sebagai b-roll)**:
  - footage disusun mengisi durasi VO. Potongan mengikuti batas kalimat: satu kalimat = 1–2 shot, `shot.maks_dtk` preset dihormati;
  - suara footage mengikuti `suara_footage` (`set_audio` / volume);
  - Generate: dari footage sumber, dengan bagian diam/kosong dibuang lewat deteksi gerak/adegan, bukan transkrip;
  - Batch: Shot Library, dipilih lewat matcher dengan **teks kalimat VO** sebagai pengganti kalimat vokal;
  - Beat Spot: potongan tetap di ketukan (§16); VO diletakkan di atas sound dengan `set_ducking` 0,3 bila `audio_pilihan: "keduanya"`.
- **Hook, CTA, SFX (§19), musik, dan watermark/penutup** mengikuti aturan mode masing-masing.
  - **Hook (keputusan venus 16 Nov)**: kalimat pertama VO dipakai **utuh** bila ≤ 12 kata, tanpa tanda baca akhir, karena naskah VO ditulis sengaja dan kalimat pertamanya adalah pembuka. Aturan ini mengalahkan `hook.dari_kalimat_kuat` dan batas `hook.baris` preset. Kalimat yang lebih panjang memakai aturan hook mode masing-masing. Hook tetap bisa diubah di editor (`vo_library.hook_vo`; berlaku di Generate & Batch, Beat Spot tidak punya hook).
  - SFX `harga`/`pop` otomatis ikut dari kata-kata di subtitle.
- **Laporan**: `rencana.json` → `"sumber_suara": "vo_library"`, `"vo": {"media", "durasi", "kalimat": n}`. Peringatan bila footage lebih pendek dari VO (footage diulang/diperpanjang, `jenis: "footage_kurang"`).
- **Hybrid**: VO, subtitle, dan shot adalah klip biasa, jadi bisa digeser, dipotong, atau diganti di editor. Saat memotong VO di editor, app memakai `voSubtitleOps` untuk menyusun ulang subtitle.

### 22.3 Pembagian kerja (usul, mohon dikonfirmasi venus/ucok)
- **ucok (app)**:
  - pilihan "VO dari Library" di halaman Video iklan, Batch, dan Beat Spot;
  - menyalin `vo-index/1` ke `<job_dir>/vo_index.json` + `refs` media VO.
- **yuki (mesin)**: Batch Remix (`batch/perencana.py`) dan Beat Spot (`batch/beatspot.py`), ditambah helper bersama `pipeline/vo_library.py` (validasi index → kalimat/kata/halaman subtitle).
- **venus (mesin)**: Generate (`edit.py`/`engine.py`), memakai helper yang sama (dilewati jalur Whisper/autocut).

### 22.4 Status implementasi
- **Helper** `pipeline/vo_library.py`:
  - `konfigurasi` (validasi `job.vo`), `muat_index` (validasi `vo-index/1` terhadap durasi file VO);
  - `kata_absolut` (waktu kata absolut; kalimat tanpa cap waktu kata dibagi rata menurut huruf);
  - `halaman`, `segmen_footage` (footage diulang mengisi durasi VO), `cut_vo` (pengganti `autocut.run_cut`).
  - Tes: `tests/test_vo_library.py`.
- **Generate — sudah jalan**:
  - `engine generate` dengan `job.vo`:
    - **tanpa Whisper**: `out/transkrip.json` = kata dari VO, dengan `sumber_suara: "vo_library"`;
    - footage boleh tanpa suara dan minimal 1 dtk.
  - `edit.py --vo-index/--vo-media/--vo-path/--vo-volume-footage`:
    - cek ucapan, kamus, dan autocut dilewati;
    - caption, hook, kata kunci, efek, SFX §19, musik, CTA, dan watermark tetap memakai aturan Generate;
    - klip VO di track `audio`; klip `video` diberi `volume` sesuai `suara_footage`.
  - Kunci VO masuk `aset_lokal` bila tidak ada di Brand Kit ekspor.
  - `engine ulang` juga memakai jalur VO, dengan transkrip VO yang sudah ada.
  - Uji di salinan job (VO 3 kalimat, 13,5 dtk), validator Motion Studio OK:
    - footage IN17 12,9 dtk → 2 klip video;
    - footage 2 dtk → diulang 7×, dengan peringatan `footage_kurang`;
    - SFX `harga` muncul di "sembilan puluh sembilan ribu" dan "diskon".
- **Aset VO tidak masuk `aset_lokal`** (Generate dan Batch). File VO ada di Media workspace, di luar folder mesin, dan app/runner sudah mengenalnya lewat **Brand Kit** (aset `vo`, kunci `$vo:<id>`). Path VO dari `sumber` job hanya dipakai mesin untuk validasi index dan `jaga_durasi`. Konsekuensinya, aset VO **wajib ada di brand_kit.json job**. Ini sudah terjadi karena `tts.ts` memasukkannya ke Brand Kit; tanpa itu validator menolak dengan "placeholder tidak dideklarasikan".
- **Batch Remix — sudah jalan** (`batch/perencana.py`):
  - VO dari Library menjadi **satu kandidat VO** (`kandidat_vo_library`): kalimat utuh dengan urutan tetap, topik dari teks, waktu kata absolut.
  - `vo_mod.susun/ragamkan` dilewati. Kalimat yang kena aturan superlatif hanya dilaporkan (`saran_buang`), tidak dibuang.
  - Variasi antar varian hanya berasal dari susunan shot. Matcher tidak menemukan footage dengan id VO, jadi semua potongan b-roll.
  - Klip audio per kalimat diambil dari `$vo:…` dengan `in_ms` = posisi kalimat di file VO.
  - `maks_per_vo` bawaan = `jumlah`.
  - `batch.json` → `sumber_suara: "vo_library"`, `vo_library: {…}`.
  - **Perbaikan umum** (berlaku juga untuk Batch biasa):
    - shot pembuka yang sudah dipakai varian lain dengan VO sama ikut dihindari. Dulu pembuka selalu sama, sehingga semua calon ditolak "pembuka sama";
    - `batch.json.calon_ditolak` = hitungan alasan penolakan calon varian.
  - Uji di salinan batch 2026-11-13_video-winning, VO 13,5 dtk: 3/3 varian dengan shot berbeda, validator OK, qc lulus.
- **Beat Spot — sudah jalan** (`batch/beatspot.py`):
  - VO utuh di track `audio` mulai 0. Bila ada sound, `set_ducking` 0,3 aktif.
  - Subtitle dibuat dari teks VO: halaman ≤ `caption.maks_kata` kata, gaya caption preset, posisi bawaan y 0,72.
  - Potongan di ketukan diperpanjang sampai menutup seluruh VO (+0,5 dtk). Bila VO lebih panjang dari target, target maksimum ikut naik dan peringatan `durasi` (info) muncul.
  - Peringatan bila sound lebih pendek dari VO atau footage tidak cukup (`footage_kurang`).
  - File VO di `sumber` **tidak** dianggap sound, walaupun itu satu-satunya audio.
  - Uji di salinan job Beat Spot R18 (preset aysilla-beatspot, footage asli, VO 13,5 dtk): 8 potongan, 18 dtk, 11 subtitle, validator OK. Tes `BeatSpot.test_vo_dari_library_suara_utama_dan_subtitle` lulus.
- **§22 lengkap**: Generate, Batch, dan Beat Spot sudah jalan. Sisi app (pilihan di 3 halaman + salin index) dikerjakan ucok.


## 23. Profil suara "Suara owner" — `engine suara_profil` (R31, v0.4.6, 16 Nov 2026, yuki; app: Hanagaki; OK venus)
Tujuannya: owner menambah contoh suaranya, mesin membersihkan dan memeriksa mutunya, lalu melatih profil. Sesudah siap, `owner:Suara owner` muncul di daftar suara §21. Pengucapannya: TTS Andika (+ pelafalan) lalu dikonversi ke suara owner (OpenVoice V2 tone converter untuk uji cepat, Applio/RVC untuk hasil utama; keduanya MIT).
- **Satu profil saja**: `owner`. Menambah profil suara orang lain perlu keputusan owner, dan mesin menolak id profil lain dengan kode 2.

### 23.1 Masukan
```json
{"schema":"engine-job/1","mode":"suara_profil","job_id":"AYS-…",
 "sumber":[{"kunci":"$media:m_abc","path":"D:/…/SHARED_MEDIA/…/v_….mp4"}, …],
 "suara_profil":{"profil":"owner","nama":"Suara owner",
                 "tambah_contoh":["$media:m_abc", …],
                 "hapus_contoh":["$media:m_old", …],
                 "latih":true,
                 "contoh_kalimat":["Halo kak, ini Loose Pants.", "…", "…"]}}
```
- **`tambah_contoh`**: kunci media yang path-nya diberikan di `sumber`, seperti media lain. Boleh berupa **video atau audio** (mp4/mov/webm/m4a/mp3/wav); mesin mengambil audionya sendiri.
- File asli **tidak diubah dan tidak dipindah**. Mesin menyalin hasil bersihnya ke folder profil.
- Contoh yang sudah pernah ditambahkan (sidik SHA-256 sama) dilewati, jadi aman bila dikirim ulang.
- **`hapus_contoh`** (opsional, usul Hanagaki): kunci contoh yang dibuang dari profil, yaitu file bersih dan sidiknya. Kunci yang tidak dikenal diabaikan. Bila model sudah dilatih, status berubah menjadi `perlu_latih_ulang` sampai `latih: true` dijalankan lagi.
- **`latih`**: `false` = hanya tambah dan periksa contoh. `true` = latih kalau total durasi bersih ≥ minimum.
- **`contoh_kalimat`**: maksimal 3 kalimat untuk contoh hasil. Bawaannya 3 kalimat jualan baku.

### 23.2 Pemeriksaan & batas (per contoh)
- **Pembersihan**:
  - Audio diubah ke mono 40 kHz.
  - Sunyi lebih dari 0,6 dtk dipotong. Bagian dengan musik atau lebih dari satu pembicara (bila terdeteksi) dibuang.
  - Sisanya disebut **durasi bersih**.
- **Mutu** per contoh: `snr_db` (perkiraan), `musik` (true bila musik latar terdeteksi), `clipping`. Contoh dengan SNR < 15 dB atau bermusik ditandai `dipakai: false` beserta `alasan`.
- **Target durasi bersih**:
  - **10–15 menit** untuk Applio.
  - **Minimal 5 menit** untuk melatih Applio.
  - **Minimal 30 dtk** untuk uji cepat OpenVoice.

### 23.3 Keluaran `out/suara_profil.json` (`suara-profil/1`)
```json
{"schema":"suara-profil/1","status":"siap|kurang_contoh|perlu_latih_ulang|ditolak","profil":"owner","nama":"Suara owner",
 "contoh":[{"kunci":"$media:m_abc","durasi":612.4,"durasi_bersih":548.0,"snr_db":31.2,"musik":false,"clipping":false,
            "dipakai":true,"alasan":null}],
 "durasi_bersih_total":548.0,"target_dtk":[600,900],"minimal_dtk":300,
 "backend":"applio|openvoice","dilatih_pada":"2026-11-16T20:00:00+07:00","versi_model":3,
 "contoh_hasil":[{"teks":"Halo kak, ini Loose Pants.","file":"out/contoh/01.wav"}, …],
 "alasan":null}
```
- **`contoh[].kunci`** = kunci di `sumber` (`$media:<media_id>`), dipakai app untuk mencocokkan baris. `contoh[]` memuat **semua contoh aktif** di profil, bukan hanya yang dikirim di job ini.
- **Progres** JSON-lines dikirim per tahap: `ambil_audio`, `bersihkan`, `periksa`, `latih` (dengan `perkiraan_dtk`; Applio ±1–2 jam di GTX 1650), `contoh`.
- **Kode keluar**:
  - 0 = selesai, termasuk `kurang_contoh` (contoh tersimpan tetapi belum dilatih karena durasi kurang);
  - 2 = ditolak (profil bukan `owner`, tidak ada contoh yang terbaca, `latih` tetapi tidak ada contoh yang lolos mutu);
  - 1 = gagal teknis.
- **Beban**: kunci AI global, prioritas Idle, menunggu RAM ≥ 3 GB (§18.0). Pelatihan sebaiknya dijalankan di jam sepi.

### 23.4 Penyimpanan & tanda siap
- **Lokasi profil**: `<DATA>/konten/suara/owner/`.
  - Isinya `contoh/` (WAV bersih), `model/` (bobot Applio + index, embedding OpenVoice), dan `profil.json`.
  - Profil berlaku untuk **satu workspace**, tidak per brand, karena suara owner sama untuk semua brand.
  - Rekaman dan model **tidak pernah masuk repo** (`konten/**` diabaikan git) dan tidak diunggah ke mana pun.
- **Tanda siap**: `engine tts {"daftar_suara":true}` menyertakan `{"id":"owner:Suara owner","backend":"owner","siap":true,…}` bila `profil.json.status == "siap"`.
  - App cukup membaca daftar suara. Tidak perlu membaca folder profil.
  - Selama belum siap, `owner:Suara owner` tidak muncul. `tts` dengan suara itu ditolak dengan kode 2.

### 23.5 Status
- **Sudah jalan**: `engine suara_profil` (`pipeline/suara_profil.py`, berjalan di .venv). Fungsinya:
  - ambil audio dari video/audio, ubah ke mono 40 kHz;
  - deteksi ucapan dari energi terhadap lantai derau, jeda dipendekkan ke maksimal 0,6 dtk;
  - hitung SNR dan clipping;
  - deteksi musik latar: sela ucapan tetap berbunyi di atas -45 dBFS dan bersifat bernada (spectral flatness < 0,2);
  - dedup dengan SHA-256, `hapus_contoh`, `perlu_latih_ulang`, `kurang_contoh`.
- **Uji audio asli** (hanya dibaca):
  - vokal IN17 hasil Demucs: SNR 28,8 dB, **dipakai**;
  - video IN17 asli (bercampur musik): **ditolak "ada musik latar"**;
  - stem musik: ditolak.
  - Tes: `tests/test_suara_profil.py` 3/3.
- **Latih + contoh hasil (16 Nov sore)**: `pipeline/suara_mesin.py`, dijalankan dengan suara-venv oleh `suara_profil.py` dan `tts.py`, di bawah kunci AI global, prioritas Idle, dan tunggu RAM.
  - **`latih: true`, durasi bersih 30 dtk – < 5 menit** → backend `openvoice` (uji cepat ±2 menit). Status `siap`; `alasan` berisi catatan "uji cepat … tambah contoh sampai minimal 5 menit untuk hasil utama Applio".
  - **≥ 5 menit** → backend `applio` (RVC v2 40 kHz, HiFi-GAN, rmvpe + contentvec, 150 epoch, batch 4, fp32). Langkahnya: preprocess → fitur → latih → index. Model akhir disalin ke `model/applio/owner.{pth,index}`, sedangkan checkpoint kerja dihapus.
  - Keduanya juga menyimpan embedding OpenVoice (`model/openvoice_se.pth`) dan nada tengah owner (`model/info.json` `f0_hz`).
  - **< 30 dtk** → `kurang_contoh` (kode 0), seperti sebelumnya.
  - Sesudah latih: `versi_model` +1, `perlu_latih_ulang: false`, lalu 3 `contoh_hasil` dibuat di `out/contoh/NN.wav` lewat jalur yang sama dengan `tts`.
- **`owner:Suara owner` di §21**:
  - TTS dasar Windows (`profil.suara_dasar`, bawaan Andika, + pelafalan) → dikonversi ke suara owner (Applio: pitch otomatis dari selisih nada tengah; OpenVoice: tone color tau 0,3) → WAV 48 kHz, lalu LUFS seperti biasa.
  - Durasi tidak berubah, jadi batas kata dari Windows tetap dipakai untuk subtitle.
- **Uji (sampel SINTETIS = suara Windows Zira, bukan rekaman orang)**:
  - OpenVoice 71 dtk bersih: 136 dtk sampai selesai, termasuk 3 contoh hasil.
  - Kemiripan warna suara ke target naik dari 0,57 (Andika dasar) ke 0,91; nada tengah 147 → 182 Hz (target 182 Hz); durasi 3,62 → 3,61 dtk.
  - Applio uji asap (5 sampel sintetis, 5,9 menit bersih, **3 epoch**, GTX 1650): 825 dtk dari awal sampai 3 contoh hasil. Kemiripan 0,57 → 0,91; nada 147 → 194 Hz; durasi tetap. Model akhir + index ±108 MB.
  - Perkiraan 150 epoch (±1–2 jam) belum diukur dengan data asli; akan dicatat saat rekaman owner masuk.
  - `engine tts` dengan `owner:Suara owner`: muncul di `daftar_suara` setelah profil siap. Subtitle dari batas kata Windows tetap pas.
  - Selama latih, kunci AI global dipegang, jadi job AI berat lain antre (sesuai §18.0).
- **Batasan**: OpenVoice tidak mengubah intonasi/logat, hanya warna suara. Hasil utama tetap Applio dengan rekaman owner 10–15 menit.

### 23.6 Bobot model (R31, unduh 16 Nov, OK venus)
Disimpan di `<TOOLS>/models/suara/`, hanya dari Hugging Face resmi. `suara_mesin.py` mengecek SHA256 sebelum dipakai dan tidak pernah mengunduh saat jalan (`HF_HUB_OFFLINE=1`). Prasyarat Applio (rmvpe, contentvec) di-*hardlink* ke folder Applio.

| File | Asal | Ukuran | SHA256 | Lisensi |
|---|---|---|---|---|
| `f0G40k.pth`, `f0D40k.pth` | HF `IAHispano/Applio` `Resources/pretrained_v2/` (pretrained RVC v2, asal RVC-Project `lj1995/VoiceConversionWebUI`) | 69,7 / 136,3 MB | `3b2c44035e782c4b14ddc0bede9e2f4a724d025cd073f736d4f43708453adfcb` / `6b6ab091e70801b28e3f41f335f2fc5f3f35c75b39ae2628d419644ec2b0fa09` | MIT (repo HF Applio & lj1995) |
| `rmvpe.pt` | HF `IAHispano/Applio` `Resources/predictors/` (bobot RMVPE yang dirilis RVC-Project) | 172,8 MB | `6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193` | ⚠ Kode RMVPE `Dream-High/RMVPE` Apache-2.0; bobotnya disebar RVC-Project (MIT). Tidak ada lisensi terpisah khusus bobot → **ditandai, boleh untuk uji internal** (venus) |
| `contentvec/pytorch_model.bin` + `config.json` | HF `IAHispano/Applio` `Resources/embedders/contentvec/` | 360,8 MB | `d8dd400e054ddf4e6be75dab5a2549db748cc99e756a097c496c099f65a4854e` | MIT (`auspicious3000/contentvec`) |
| `openvoice_v2/checkpoint.pth` + `config.json` | HF `myshell-ai/OpenVoiceV2` `converter/` | 125,2 MB | `9652c27e92b6b2a91632590ac9962ef7ae2b712e5c5b7f4c34ec55ee2b37ab9e` | MIT |

SHA256 yang sama tertulis di `SHA` dalam `pipeline/suara_mesin.py`.
- **Paket**: `pipeline/requirements-suara.txt`. Applio 3.7.1 (commit `6f69726b`) dan OpenVoice (commit `74a1d147`, dipasang `--no-deps`).
- **Tidak dipakai/diblokir**:
  - `edge-tts` **dilepas** dari suara-venv dan `import edge_tts` diblokir di `suara_mesin.py`, karena mengirim teks ke server Microsoft.
  - Watermark OpenVoice (`wavmark`, mengunduh model) dan `openvoice.api` tidak dipakai; konverternya dipanggil langsung.
  - UI Gradio Applio, `pypresence`, pemeriksa versi, dan pengunduh prasyarat Applio tidak dipanggil.

## 24. Profil suara per orang: `grace`, `julia`, `niar` (v0.4.7, 23 Nov 2026, Hanagaki; keputusan owner lewat venus) — DRAF
Owner menyatakan ketiganya adik owner dan sudah setuju suaranya dikloning. Semua aturan §23 tetap berlaku, per profil.

- **Profil yang diterima** `suara_profil.profil`: `owner` (bawaan bila kosong), `grace`, `julia`, `niar`. Selain itu ditolak dengan kode 2.
- **Nama tetap**: `Suara owner`, `Suara Grace`, `Suara Julia`, `Suara Niar`. Field `nama` dari job diabaikan, supaya id suara tidak tertukar.
- **Penyimpanan**: `<DATA>/konten/suara/<profil>/`, masing-masing punya `contoh/`, `model/`, dan `profil.json` sendiri.
- **Tidak tercampur**: rekaman (sidik SHA-256) yang sudah dipakai satu profil ditolak dengan kode 2 bila dikirim ke profil lain. Pemeriksaan ini berjalan sebelum profil diubah.
- **Daftar suara §21**: tiap profil yang siap muncul sebagai `<profil>:<nama>`, misalnya `grace:Suara Grace`, dengan `backend` = id profil. Yang belum siap tidak muncul.
- **Backend latih** tetap menurut durasi bersih (§23.5): ≥ 5 menit Applio, 30 dtk – < 5 menit OpenVoice uji cepat.
- **App**: `POST` job masih mengirim `profil: owner`. Pilihan profil di tab "Suara saya" menyusul di sisi app.

## 25. Mode lanjut latihan Applio (v0.4.8, 23 Nov 2026, Hanagaki; diminta venus) — DRAF
Tujuannya: latihan panjang bisa dibagi per malam tanpa mengulang dari nol.

**Masukan tambahan** `suara_profil` (opsional):
- `jeda_pukul`: `"HH:MM"` waktu lokal. Latihan berhenti di checkpoint terakhir yang masih sempat sebelum jam itu.
- `mulai_baru`: `true` membuang progres lama secara sengaja. Bawaan `false`.

**Keluaran**: status baru `dijeda` (kode 0) dengan `epoch` dan `total_epoch`. Model belum berubah (`versi_model` tetap). Menjalankan `latih: true` lagi melanjutkan.

**Aturan**:
- Checkpoint tiap 10 epoch. Baris epoch N dicetak sebelum checkpoint N ditulis, jadi cadangan dibuat saat epoch N+1 muncul.
- Cadangan `_kerja/cadangan/eNNNN/{G,D}.pth`: disalin, dibaca ulang, epoch G dan D harus sama, SHA-256 dicatat di `_kerja/lanjut.json`. Dua cadangan terakhir disimpan.
- Dilanjutkan hanya bila sidik contoh + batch + sample rate sama dan cadangan utuh.
- Bila contoh atau setelan berubah saat ada progres: **gagal keras**, progres tidak dihapus. Progres hanya dibuang dengan `mulai_baru: true`.
- **Adopsi progres lama** (sekali jalan): `suara_lanjut.py adopsi <kerja> <sha256.json> <epoch> <total> <batch> <sr> <contoh…>`. G/D harus cocok dengan SHA, epoch, dan dataset. Tidak menghapus apa pun.
- `jeda_pukul` saat melanjutkan: bila checkpoint berikutnya diperkirakan tidak sempat, latihan tidak dimulai dan status tetap `dijeda`. Pada latihan baru, lama blok pertama belum diketahui, jadi jeda bisa terlambat sampai checkpoint pertama.
- Status `dijeda` bertahan di job berikutnya (`latihan_jeda` di laporan). `openvoice_se.pth` baru diganti setelah latihan selesai.
- Checkpoint rusak, catatan hilang, atau Applio tidak mulai dari epoch N+1 = **gagal keras** (kode 1). Folder kerja tidak dihapus.
- Hanya proses Applio milik job itu yang dihentikan. Kunci AI dilepas setelah job berakhir.

## 26. Video Iklan dengan beberapa footage (v0.4.9, 24 Nov 2026; permintaan owner lewat venus) — DRAF

Owner ingin satu video iklan bisa memakai beberapa footage sekaligus (mis. `Konten 1 (1)`, `Konten 2 (2)`, `Konten 3 (1)`). Mesin menggabungkannya sesuai urutan pilihan tim menjadi satu video, lalu menyusun draf seperti biasa. Nomor 24 dan 25 sudah dipakai draf suara di branch `hotfix/suara-*`, maka bagian ini memakai nomor 26.

**26.1 `job.json` (mode `generate`), aditif**

- Satu footage: tetap `sumber: [{ "kunci": "$sumber", "path": … }]` (job lama tidak berubah).
- Beberapa footage (2–20): `sumber` berisi `$sumber:<id>` untuk tiap footage. **Urutan daftar adalah urutan di video.** App memakai `$sumber:f01`, `$sumber:f02`, dan seterusnya. Footage yang sama boleh dipakai dua kali dengan kunci berbeda. `$vo:<aset>` (§22) tetap boleh ikut dan bukan footage.
- App menolak campuran `$sumber` dan `$sumber:<id>`, kunci kembar, atau lebih dari 20 footage. Mesin juga menolaknya (kode 2).

**26.2 Penggabungan (`pipeline/gabung.py`)**

- Tiap footage disamakan dulu: gambar **1080×1920**, skala menutup bingkai lalu dipotong di tengah (sama seperti satu video yang "dipotong ke 9:16"), **30 fps**, yuv420p. Suara **48 kHz stereo**. Footage tanpa suara diberi hening sepanjang gambarnya.
- Panjang tiap bagian = panjang gambarnya, dibulatkan ke frame utuh 30 fps. Gambar yang sedikit lebih pendek diisi frame terakhir dan suara dipotong atau ditambah hening, jadi suara bagian berikutnya tidak bergeser.
- Hasil: `<job_dir>/out/gabungan.mp4` (H.264 CRF 18 + AAC 192k) dan `out/gabungan.json` (`gabungan/1`: `bagian`, `durasi`, `sidik`). Bila isi dan urutan footage sama (`engine ulang`, "Tetap lanjut" di job yang sama), file dipakai ulang. File asli tidak pernah diubah.
- Progres: tahap baru `gabung` (`persen` 8–12).
- Ditolak (kode 2): file bukan video, video kosong, lebih dari 20 footage, atau semua footage tanpa suara padahal tidak memakai VO dari Library.

**26.3 Hasil**

- Transkrip, potongan, caption, hook, dan efek berjalan di atas `gabungan.mp4`, sama seperti satu video.
- `ops.json`: klip video memakai placeholder **`$gabungan:video`** (bukan `$sumber`) dan `aset_lokal` memuat `{ "kunci": "$gabungan:video", "path": "<job_dir>/out/gabungan.mp4" }`.
- `rencana.json` mendapat `sumber_gabungan`: `{ kunci, durasi, kanvas: [1080, 1920], fps: 30, bagian: [{ kunci, nama, mulai_ms, durasi_ms, suara }] }`. `mulai_ms` adalah posisi bagian itu di video gabungan.

**26.4 App (Motion Studio)**

- Form Video iklan: pilih beberapa file sekaligus, tambah lagi, ubah urutan (↑/↓), hapus satu per satu. Durasi tiap file dan totalnya tampil sebelum diunggah. File diunggah satu per satu.
- `$gabungan:video` hanya diterima bila berada di folder `out/` job itu sendiri (bukan symlink ke luar, harus `.mp4`). File diimpor sekali lewat salinan sementara sebagai media proyek dan diingat di `refs.json`.
- Draf tetap hybrid: potongan ada di timeline sebagai klip biasa yang bisa digeser, dipotong, atau dihapus, dengan satu undo. Kartu rencana menampilkan jumlah footage dan durasi tiap bagian.

**26.5 Footage tanpa ucapan dipakai utuh**

- Setelah transkrip, bagian gabungan yang tidak berisi ucapan (file bisu, atau bersuara tanpa satu kata pun) ditulis sebagai `utuh: [[mulai_ms, akhir_ms], …]` di `out/transkrip.json`. Auto-cut (`autocut.run_cut`) selalu memakai rentang itu penuh dan tidak menganggapnya jeda, jadi b-roll tidak hilang dari draf.
- Kata di bagian yang file-nya bisu dibuang dari transkrip, karena itu karangan Whisper dari hening dan tidak boleh tampil sebagai caption.
- Pilihan tim tetap menang: rentang `koreksi.buang` dikurangkan dari `utuh`.
- `rencana.json`: `sumber_gabungan.bagian[].utuh` (true/false) dan peringatan `info` berjenis `footage_utuh` yang menyebut footage ke berapa.

## 27. Keluhan tim: typo, potongan, instruksi catatan, gerak halus (v0.5.0, 24 Nov 2026) — DRAF

Semua aditif. Job tanpa `brief.catatan` dan ops lama tetap valid.

**27.1 Typo subtitle**
- Kamus (`teks.kamus`) toleran: huruf besar/tanda baca diabaikan; kata terakhir boleh bersufiks `-nya`/`-lah`/`-kah` dan sufiksnya ikut di hasil ("selananya" → "celananya"); kunci multi-kata boleh beda 1 huruf per kata (hanya kata ≥ 4 huruf), kecuali teksnya sendiri sudah kata benar (nilai kamus/kosakata). Kunci satu kata tetap harus persis.
- Petunjuk Whisper (`hotwords` + `initial_prompt`) dibatasi **token** (tokenizer model, ≤ 200 token termasuk contoh pengisi; batas faster-whisper 223), bukan 40 entri. Urutan: nama brand → `brief.produk` + `brief.varian` (mesin meneruskannya ke `transcribe.py --produk/--varian`) → kata benar kamus → kosakata → kata kunci → produk Brand Kit.
- Harga tidak terbelah: "Rp89" + ".000" digabung jadi satu kata (aturan Batch), dan halaman caption tidak memecah angka ("Rp 89 ribu" = satu blok, maks 3 kata).
- Kata dengan keyakinan < 0,05 yang bukan angka/kosakata brand tidak tampil di caption (audio tetap), kecuali diapit kata yakin ≤ 0,3 dtk di kedua sisi (tetap tampil, masuk `ragu`). Laporan: `potongan.json` `kataRaguDisembunyikan`, dan `rencana.ragu`.

**27.2 Potongan**
- Kata < 0,3 tanpa kata yakin (≥ 0,5, durasi > 0) dalam 0,6 dtk, atau kata ragu yang "panjangnya" ≥ 1,5 dtk, dibuang dari potongan (`dibuang[].jenis`: "karangan Whisper (ragu, terisolasi)"). Angka, kosakata brand, dan kata hasil kamus tidak terkena.
- Sisa potongan tanpa satu kata pun dan < 0,5 dtk dibuang. §26.5 (footage tanpa ucapan dipakai utuh) tidak berubah.

**27.3 Instruksi tim dari `brief.catatan`** (aturan, tanpa AI/jaringan; `pipeline/instruksi.py`)
- Dikenali: "jangan pakai / buang / hapus / tanpa / skip footage N[, M dan K]" (juga "ke-2", "kedua", "terakhir"), "hanya pakai footage N[, M]", dan "buang/hapus kalimat|kata '…'" (teks wajib dalam tanda kutip). Penerapannya sama dengan `koreksi.buang` (`dibuang[].sumber: "user"`, `jenis` memuat "instruksi tim"). Nomor footage = urutan `sumber` (§26.1); satu footage = footage 1.
- `rencana.instruksi_tim`: `{ teks, dipahami: [{ kalimat, aksi, footage?, teks?, ditemukan?, detik?, hasil? }], otomatis: [{ kalimat, catatan }], tidak_dipahami: [{ kalimat, alasan }] }`. `otomatis` = memang sudah dikerjakan mesin (gabung footage, buang jeda/pengulangan). Bila `tidak_dipahami` tidak kosong: peringatan `info` berjenis `instruksi_tim`. Teks kutipan yang tidak ditemukan: peringatan `warn`. Instruksi yang akan membuang semua footage tidak diterapkan.

**27.4 Gerak halus (Generate saja; Batch tidak berubah)**
- Efek `zoom` di track `effects` hanya untuk lompatan skala di sambungan potongan (`mode: "cut"`).
- Dorong pelan dan zoom-through ditulis sebagai `keyframes` klip video (§12.5): dorong pelan 1 → 1,05 naik 600–1200 ms `ease`, tahan, lalu kembali ke 1 (titik kembali selalu ada); zoom-through 1 → 1,35 dalam 250 ms sebelum titik potong lalu kembali ke 1 dalam 300 ms, `ease`. Titik di luar klip menjadi jangkar (gerak menyambung lintas potongan); maks 20 per klip. `rencana.efek` mencatatnya dengan jenis `zoom` / `zoom_through` + `keyframe: true`. SFX whoosh untuk zoom-through dibaca dari puncak keyframe.
- Klip SFX mesin (Generate dan Batch, `sfx_rencana`) memakai `fade_in_ms: 4` dan `fade_out_ms: 15` (40 bila bunyinya terpotong SFX berikutnya), maks ⅓ panjang klip (§12.1).

## 28. Suara dari Teks: pilih model, gaya bicara, ubah suara (v0.5.1, 25 Nov 2026, yuki; owner 24 Nov: "tim tinggal pilih", rilis 25 Nov kecuali Niar) — DRAF
Alur di app: ketik teks **atau** upload rekaman VO → suara → kecepatan → gaya bicara → model pembaca. Tambahan aditif pada `job.tts` (§21):
- `model`: `andika` (bawaan, perilaku §21/§23 tetap) | `chatterbox` | `zonos`. Model neural meniru ±12 dtk rekaman asli profil, jadi `suara` wajib profil (`owner`/`grace`/`julia`/`niar`); suara Windows ditolak kode 2. Maks 25 kalimat per job (batas waktu job server 30 menit).
- `gaya`: `natural` | `jualan` | `ramah` | `cerita` | `tegas` | `heboh` → parameter model (`GAYA` di `tts.py`; Chatterbox: exaggeration/cfg_weight/temperature, ZONOS: speaking_rate/loudness). Andika tidak punya gaya.
- `perkuat_warna` (bawaan `true`): hasil neural diubah lagi oleh model Applio profil.
- `audio: "$sumber"` + `job.sumber[{kunci:"$sumber"}]`: **ubah suara** rekaman siapa pun ke profil (Applio). Intonasi & jeda ikut rekaman; model/gaya diabaikan; kecepatan berlaku; maks 10 menit; laporan `model: "ubah_suara"`, satu file tanpa kata.
- Laporan `tts.json` tambahan: `model`, `gaya`, `perkuat_warna`, `kata_perkiraan: true` (cap waktu kata neural = perkiraan menurut panjang huruf di bagian bersuara). Daftar suara (`daftar_suara`) tambahan: `model[{id,nama,siap,gaya}]`, `gaya[{id,label,jeda_ms}]`.
- Mesin: `pipeline/tts_neural.py` jalan di `<TOOLS>/chatterbox-venv` atau `<TOOLS>/zonos-venv`, bobot `<TOOLS>/models/tts-uji` (offline, SHA256 di folder bobot), di bawah kunci AI global, prioritas Idle, maks 4 thread. Chatterbox GPU, jatuh ke CPU bila memori GPU penuh; ZONOS CPU.
