---
name: "aysilla-re-uploadbrand"
description: Edit rekaman BARU orang bicara ke kamera (talking head jualan) untuk brand Aysilla Factory menjadi iklan 9:16 TikTok / Instagram Reels maks 30 detik, memakai pipeline Remotion di D:\VIBECODING\remotion (transkrip Whisper -> auto-cut -> caption per kata -> efek -> render -> MetaClean). Pakai saat user minta edit video Aysilla, menyebut "gaya aysilla", mengirim rekaman talking head untuk Aysilla, atau minta render/revisi video Aysilla. JANGAN pakai untuk mengunggah ulang video lama/winning atau unduhan TikTok/IG — itu tugas skill aysilla-versi-baru.
---

# Gaya Edit: Aysilla Factory — Talking Head Jualan

Versi **v0.2 (12 Nov 2026)**. Nilai bertanda `[SEMENTARA]` belum dikonfirmasi tim: ikuti, tapi sebutkan di laporan
kalau terasa tidak cocok. Semua perintah dijalankan dari folder project `D:\VIBECODING\remotion`.

## 0. Skill yang mana?

| Situasi | Skill |
|---|---|
| Rekaman **baru** (belum pernah diunggah) → jadi iklan | **ini** |
| Video **lama/winning** mau diunggah lagi, unduhan TikTok/IG, atau kena "Konten yang Tidak Orisinal" | `aysilla-versi-baru` (membuat naskah & rekaman baru, lalu kembali ke skill ini untuk edit) |
| Membuat efek/komposisi Remotion baru | skill `haidry` (aturan motion design), lalu daftarkan efeknya di bagian 6 |

Kalau rekaman ternyata potongan video yang sudah pernah terbit, berhenti dan arahkan ke `aysilla-versi-baru`.

## 1. Input

| Input | Lokasi | Wajib |
|---|---|---|
| Rekaman mentah (vertikal, satu orang bicara) | `public/masuk/<nama>.mp4` (salin ke sini; `<nama>` pendek tanpa spasi, mis. `celana01`) | Ya |
| Brief (produk, harga/promo, placement) | pesan user atau `brief.md` | Ya untuk harga/promo |
| Brand kit | `brandkit/aysilla.json` (warna, font, logo, handle, `kamus_kata`, `kata_kunci`, `superlatif_dilarang`) | Ya, baca dulu |

Tanpa harga/promo di brief: **jangan tampilkan angka harga** selain yang benar-benar diucapkan.

## 2. Alur kerja (berurutan)

**1. Cek input**
```
ffprobe -v error -show_entries stream=codec_type,width,height,avg_frame_rate:format=duration -of compact public\masuk\<nama>.mp4
```
Harus vertikal (tinggi > lebar), ada audio. Laporkan masalah (horizontal, tanpa suara, lebih dari satu pembicara,
musik keras di rekaman) sebelum lanjut.

**2. Transkrip per kata** (GPU otomatis, jatuh ke CPU)
```
.venv\Scripts\python pipeline\transcribe.py public\masuk\<nama>.mp4 out\<nama>\transkrip.json --brandkit brandkit\aysilla.json
```
Baca hasilnya. Kata yang salah dengar dan berulang → usulkan tambahan `kamus_kata` / `kosakata_whisper` ke user
(jangan ubah brand kit tanpa izin).

**3. Rencana edit otomatis**
```
.venv\Scripts\python pipeline\edit.py out\<nama>\transkrip.json --brandkit brandkit\aysilla.json --video masuk/<nama>.mp4 --out out\<nama> --placement tiktok
```
Opsi yang sering dibutuhkan:
- `--caption-pos atas` → produk **bawahan** (celana, rok) supaya caption tidak menutup produk.
- `--hook-end-sec <dtk>` → rekaman sudah punya teks tertanam di awal yang perlu ditutup judul hook.
- `--placement instagram` → CTA versi Reels.
- `--max-seconds` / `--min-seconds` → hanya kalau user minta durasi lain.

`edit.py` menulis `out/<nama>/potongan.json` (bagian dibuang + alasan, `overMax`, `underMin`, keraguan) dan
`out/<nama>/props.json` (caption, kata kunci, hook, framing, zoom-through, SFX, musik, CTA). Ia otomatis:
koreksi `kamus_kata`, menyembunyikan superlatif terlarang dari layar, auto-cut, kata kunci maks 1 per layar,
judul hook, rencana efek, SFX.

**4. Kirim rencana ke user, lalu TUNGGU konfirmasi.** Isi ringkas:
- durasi mentah → durasi jadi (`originalSec`, `totalWithOutroSec`)
- bagian dibuang + timestamp + alasan (`removed`)
- judul hook, kata kunci yang diperbesar, efek + detiknya
- hal yang diragukan (kata superlatif yang masih terdengar di audio, kata ber-confidence rendah, `overMax`/`underMin`)
Pengecualian: user menulis "langsung render" → lewati konfirmasi.

**5. Revisi rencana (kalau diminta)**: ubah `out/<nama>/props.json` seperlunya (teks hook, kata kunci, posisi caption)
— teks hanya dari ucapan/brief. Durasi masih > 30 dtk → jangan potong ekor (CTA di akhir); tawarkan bagian tengah yang
bisa dibuang, tunggu jawaban, lalu jalankan ulang langkah 3 atau ubah `segments`.

**6. Render draf (cepat, setengah resolusi) untuk dicek**
```
.venv\Scripts\python pipeline\render.py out\<nama>\props.json --name aysilla_th_<produk> --draf
```
→ `public/Output/aysilla_th_<produk>_draf.mp4`.

**7. Render final**
```
.venv\Scripts\python pipeline\render.py out\<nama>\props.json --name aysilla_th_<produk>
```
→ `public/Output/aysilla_th_<produk>_vNN.mp4` (nomor versi naik otomatis; versi lama tidak ditimpa; loudness
dinormalkan ke −14 LUFS, true peak −1 dB).

**8. QC dengan melihat frame** (wajib, jangan lapor selesai tanpa melihat gambar)
Ambil satu frame per titik: detik 0,5 dan 2,5 (hook), tiap efek (`zoomThroughs`, pergantian `framing`), durasi−3
dan durasi−1 (CTA, outro):
```
ffmpeg -v error -y -ss <detik> -i public\Output\aysilla_th_<produk>_vNN.mp4 -frames:v 1 out\<nama>\qc\<detik>.jpg
```
Buka gambarnya (Read). Cek dengan checklist bagian 10.

**9. Bersihkan metadata dengan MetaClean** (langkah terakhir sebelum upload)
```
"D:\VIBECODING\TOOLS META DATA\dist\MetaClean\metaclean-cli.exe" --preset final --in public\Output\aysilla_th_<produk>_vNN.mp4 --out public\Output\siap-upload --report public\Output\siap-upload\laporan_<produk>.json
```
Exit code harus 0 (CLEAN). Rekaman sudah 1080p → jangan pakai upscale/60 fps.

**10. Laporan ke user**: durasi awal vs akhir, jumlah potongan, efek yang dipakai, waktu render, hasil QC (sertakan
1–2 frame), status MetaClean, dan hal yang diragukan. Ingatkan: setelah video diunggah, catat naskahnya ke arsip
(`pipeline\cek_orisinal.py catat ...`, lihat skill `aysilla-versi-baru`).

## 3. Durasi & format

| Item | Nilai |
|---|---|
| Durasi maksimal | **30 detik**, termasuk outro |
| Durasi minimal | 15 detik `[SEMENTARA]` |
| Master | 9:16, 1080 × 1920, 30 fps, MP4 H.264 + AAC |
| Placement | TikTok + Instagram Reels |
| Safe area | Tanpa teks di 15% bawah, 12% kanan (tombol TikTok/Reels), 10% atas |

## 4. Struktur video

| Babak | Porsi (video 30 dtk) | Isi |
|---|---|---|
| Hook | 0–3 dtk | Kalimat terkuat + judul maks 6 kata, diambil dari ucapan |
| Masalah / konteks | 3–8 dtk | Masalah penonton |
| Produk & bukti | 8–22 dtk | Penjelasan produk, keunggulan, demo |
| Penawaran | 22–25 dtk | Harga/promo HANYA dari ucapan atau brief |
| CTA & outro | 25–30 dtk | CTA + logo + handle |

Kalimat terkuat ada di tengah → **jangan memindah urutan ucapan** tanpa izin; sebutkan sarannya di rencana.
Ritme: jeda tersisa maks 0,3 dtk; buang "eee/emm/hmm" dan napas panjang; kalimat diulang → pakai take terakhir yang
lengkap; ganti framing tiap 2–4 dtk `[SEMENTARA]`.

## 5. Caption & teks di layar

| Aturan | Nilai |
|---|---|
| Model | Per kata, kata yang sedang diucapkan menyala |
| Maks kata per layar | **3** |
| Warna | Cream `#FFFDD0` + outline gelap (brand kit) |
| Kata kunci | ±1,4×, warna aksen, pop 0,1 dtk; maks 1 per layar dan rata-rata ≤ 1 per 2 dtk |
| Huruf | Kata kunci KAPITAL, sisanya kapital di awal kalimat |
| Posisi | Sepertiga bawah di atas safe area; **produk bawahan atau wajah di bawah → `--caption-pos atas`**; tidak boleh menutup wajah/produk |
| Emoji | Tidak dipakai |
| Bahasa | Sesuai ucapan; hanya perbaiki ejaan |

Kata kunci otomatis: nama produk & `kamus_kata`, angka/harga/ukuran yang diucapkan, daftar `kata_kunci`.

## 6. Efek video (maks 3 jenis per video)

**Tersedia di komposisi `AdVideo`** (direncanakan otomatis oleh `edit.py`, jarak antar efek besar ≥ 5 dtk):

| No | Efek | Field di `props.json` | Kapan |
|---|---|---|---|
| 17 | Glass type (judul hook) | `hook` | Teks judul 0–3 dtk |
| 05 | Digital zoom (ganti framing) | `framing` | Penekanan, ganti framing tiap 2–4 dtk |
| 09 | Zoom-through cut | `zoomThroughs` | Transisi antar babak / di potongan |

**Belum dibuat** (boleh secara gaya, tapi komponennya belum ada): 07 Checklist (2+ keunggulan berurutan),
16 Cover story (hook/outro, maks 1×), 06 Phone mockup (butuh tangkapan layar produk), 11 Pull-back reveal (butuh
footage produk tambahan), 04 Frame break (tangan/produk mendekat), 10 Chart grow (hanya angka dari ucapan/brief).
Kalau salah satu cocok untuk video ini: **usulkan di rencana edit**, dan baru dibuat (pakai skill `haidry`, ditambah ke
`src/AdVideo/` + `schema.ts`) setelah user setuju. Jangan membuatnya diam-diam di tengah edit.

**Hindari**: 01 Orbit, 03 UI world, 13 Paper cut, 14 Doodle boil. **Jangan**: 02 Couch wall, 08 Headline wall,
12 Green screen, 15 Vertigo (artefak di wajah/hijab atau butuh teks yang tidak diucapkan).

## 7. Audio

| Aturan | Nilai |
|---|---|
| Suara utama | Suara asli pembicara, selalu paling jelas |
| SFX | `sfx/pop.wav` saat kata kunci, `sfx/whoosh.wav` saat hook/transisi (otomatis); maks 1 per 2 dtk; tanpa suara kaget/kartun |
| Musik latar | Instrumental tanpa lirik, **hanya dari `public/musik/`** (lisensi aman). Folder belum ada/kosong → tanpa musik, sebutkan di laporan `[SEMENTARA]` |
| Volume musik | Jauh di bawah suara |
| Loudness akhir | −14 LUFS, TP −1 dB (otomatis di `render.py`; perlu dicocokkan dengan standar platform) |

## 8. Aturan wajib & larangan

- Teks di layar **hanya dari ucapan atau brief**. Tidak mengarang kalimat, slogan, testimoni.
- Harga, diskon, stok, angka **hanya dari ucapan atau brief**.
- Wajah dan produk tidak boleh tertutup teks, logo, stiker.
- Aset (musik, gambar, footage) hanya dari `public/`.
- **"Paling murah"** dan superlatif di `superlatif_dilarang` (termurah, no. 1, terbaik se-Indonesia, …) tidak boleh
  tampil sebagai teks. Kalau diucapkan: `edit.py` menyembunyikannya dari caption; tetap **laporkan** karena masih
  terdengar di audio, dan sarankan take ulang kalimat itu.
- Jangan memakai footage dari video yang sudah pernah terbit atau unduhan platform (lihat bagian 0).

## 9. CTA & outro

| Placement | Teks CTA |
|---|---|
| TikTok | **"Cek keranjang kuning sekarang"** |
| Instagram Reels | "Cek link di bio" `[SEMENTARA]` — jangan pakai CTA keranjang kuning di versi IG |

User minta satu file untuk dua platform → tanyakan CTA mana. Outro 2–3 dtk: logo + handle dari brand kit, latar gelap
brand. Logo/handle belum diisi di brand kit → pakai teks "Aysilla Factory" dan laporkan.

## 10. Checklist QC (wajib lulus sebelum lapor selesai)

- [ ] Durasi ≤ 30 dtk dan ≥ durasi minimal; 1080 × 1920, 30 fps
- [ ] Hook muncul di 3 detik pertama
- [ ] Tidak ada jeda > 0,3 dtk atau take salah tersisa
- [ ] Ejaan sesuai `kamus_kata`
- [ ] Tidak ada teks superlatif terlarang; superlatif yang terdengar di audio sudah dilaporkan
- [ ] Harga/angka di layar sama persis dengan ucapan/brief
- [ ] Caption maks 3 kata, di safe area, tidak menutup wajah/produk (cek frame!)
- [ ] Maks 3 jenis efek, semuanya dari daftar "Tersedia" (atau efek baru yang sudah disetujui)
- [ ] Musik di bawah suara, tidak pecah (atau tanpa musik dan dilaporkan)
- [ ] CTA sesuai placement; logo + handle di outro
- [ ] File di `public/Output/` dengan nomor versi baru; versi lama utuh
- [ ] MetaClean exit 0 (CLEAN), hasil di `public/Output/siap-upload/`
