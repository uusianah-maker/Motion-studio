---
name: remotion-konversi
description: Edit rekaman UGC Aysilla Factory (kreator bicara/review dengan suara asli) jadi video KONVERSI/jualan 9:16 TikTok & Reels lewat pipeline Remotion di D:\VIBECODING\remotion. Pakai saat diminta video jualan/konversi/checkout.
---

# Aysilla Factory — UGC untuk KONVERSI

Versi v0.1 (12 Nov 2026). Nilai bertanda `[SEMENTARA]` belum dikonfirmasi owner: ikuti, tapi sebutkan di laporan kalau
terasa tidak cocok. Semua perintah dijalankan dari `D:\VIBECODING\remotion`.

## 0. Tujuan video ini

Konversi = **membuat penonton membeli sekarang**. Setiap detik harus menjawab: kenapa butuh, bukti produknya bagus,
berapa harganya (jika ada di brief/ucapan), dan apa yang harus diklik. Ukuran keberhasilan: klik ke produk & checkout.

| Skill lain | Kapan |
|---|---|
| `remotion-branding` | Membangun citra & kepercayaan brand |
| `remotion-awareness` | Menghentikan scroll, dikenal orang baru |
| `aysilla-re-uploadbrand` | Talking head jualan format lama (maks 30 dtk) |
| `aysilla-versi-baru` | Video lama/winning/unduhan platform mau diunggah ulang |

Kalau user tidak menyebut tujuan, tanyakan dulu: awareness, branding, atau konversi.

## 1. Input & mode audio

| Input | Lokasi | Wajib |
|---|---|---|
| Rekaman UGC (vertikal) | `public/masuk/<nama>.mp4` (`<nama>` pendek, tanpa spasi) | Ya |
| Brief (produk, varian, **harga/promo persis**, info live jika ada) | pesan user atau `brief.md` | **Wajib** untuk harga/promo |
| Brand kit | `brandkit/aysilla.json` | Ya, baca dulu |
| Aset brand | `public/sfx/`, `public/musik/` (+ `lisensi.txt`), logo di `brandkit/aysilla.json` | Logo disarankan |

Tentukan **mode audio** dari hasil transkrip:

| Mode | Ciri | Status |
|---|---|---|
| A. Suara asli | Kreator bicara/review ke kamera atau sambil memperagakan produk | **Didukung** — lanjut |
| B. VO terpisah | Ada file `public/masuk/<nama>_vo.mp3/.wav` (mis. ElevenLabs) di atas footage | **Belum didukung** pipeline. Berhenti, laporkan, usulkan dibangun |
| C. Tanpa ucapan | Transkrip < 5 kata; hanya musik/ambient | **Belum didukung**. Berhenti, laporkan |

Bahasa: ikuti ucapan apa adanya (campur Indonesia–Inggris boleh). Hanya perbaiki ejaan lewat `kamus_kata`.

## 2. Alur kerja

1. **Cek input** (`ffprobe`): vertikal, ada audio, satu pembicara utama. Masalah → laporkan sebelum lanjut.
2. **Transkrip**:
   ```
   .venv\Scripts\python pipeline\transcribe.py public\masuk\<nama>.mp4 out\<nama>\transkrip.json --brandkit brandkit\aysilla.json
   ```
3. **Rencana edit** — durasi mengikuti materi (lihat bagian 3):
   ```
   .venv\Scripts\python pipeline\edit.py out\<nama>\transkrip.json --brandkit brandkit\aysilla.json --video masuk/<nama>.mp4 --out out\<nama> --placement tiktok --max-seconds <durasi mentah dibulatkan ke atas> --min-seconds 5
   ```
   Produk bawahan (celana) → tambah `--caption-pos atas` supaya caption tidak menutup produk.
4. **Kirim rencana, TUNGGU konfirmasi** (kecuali user menulis "langsung render"):
   - durasi mentah → durasi jadi; bagian dibuang + alasan
   - hook (kalimat + judul), kata kunci, efek + detik + **alasan dari kondisi video** (bagian 5)
   - CTA yang dipilih per platform + alasannya (bagian 6)
   - keraguan: kata ber-confidence rendah, superlatif terlarang yang terdengar, efek yang belum tersedia
5. **Render draf** lalu **final**, satu file per platform:
   ```
   .venv\Scripts\python pipeline\render.py out\<nama>\props.json --name aysilla_ugc-kv_<produk>_tt
   ```
   Versi Instagram: jalankan ulang langkah 3 dengan `--placement instagram`, render dengan nama `..._ig`.
   Tambah `--draf` untuk draf cepat. Versi lama tidak ditimpa.
6. **QC dengan melihat frame**: detik 0,5 dan 2,5, tiap efek, durasi−3, durasi−1. Cek dengan bagian 10.
7. **MetaClean** (sebelum upload):
   ```
   "D:\VIBECODING\TOOLS META DATA\dist\MetaClean\metaclean-cli.exe" --preset final --in public\Output\<file>.mp4 --out public\Output\siap-upload --report public\Output\siap-upload\laporan_<produk>.json
   ```
8. **Laporan**: durasi awal vs akhir, potongan, efek, CTA, waktu render, hasil QC + 1–2 frame, status MetaClean, keraguan.

## 3. Durasi & format

- **Durasi mengikuti materi**: hasil = rekaman setelah jeda, "eee", take salah dibuang, + outro. Tidak dipaksa ke angka
  tertentu dan tidak boleh diisi/dipanjangkan.
- Panduan (bukan batas): konversi paling efektif padat. Kalau hasil > 35 dtk, tawarkan versi lebih pendek (bagian
  tengah yang bisa dibuang) di rencana; kalau > 60 dtk, wajib tanya user. **Ekor video (penawaran & CTA) tidak pernah
  dipotong otomatis.**
- Master 9:16, 1080 × 1920, 30 fps, MP4 H.264 + AAC.
- Placement: TikTok (`_tt`) dan Instagram Reels (`_ig`).
- Safe area: tanpa teks di 15% bawah, 12% kanan, 10% atas.

## 4. Struktur & ritme konversi

| Babak | Isi |
|---|---|
| Hook (≤ 3 dtk) | Masalah atau hasil paling mencolok dari ucapan + judul maks 6 kata |
| Masalah | Males nyetrika, celana gampang kusut/panas |
| Bukti | Try-on, detail bahan, before-after, demo kusut vs tidak — sesuai yang ada di rekaman |
| Penawaran | Harga/promo **persis seperti brief** (mis. "80rb-an" tampil apa adanya) atau yang diucapkan |
| CTA | CTA beli sesuai platform + logo |

- Ritme: ganti framing tiap **2–3 dtk**; jeda tersisa maks 0,3 dtk.
- Harga **ditonjolkan** sebagai kata kunci di babak penawaran — hanya jika ada di brief atau ucapan.
- Kata urgensi (stok terbatas, hari ini saja) **hanya** jika tertulis di brief.
- Kalimat terkuat ada di tengah → jangan pindah urutan ucapan tanpa izin; usulkan di rencana.

## 5. Efek — dipilih dari kondisi video

Maks **3 jenis** per video, jarak antar efek besar ≥ 5 dtk. Pilih berdasarkan apa yang benar-benar ada di rekaman, lalu
tulis alasannya di rencana.

**Tersedia sekarang** (komposisi `AdVideo`):

| Efek | Pakai jika kondisi video… |
|---|---|
| 17 Glass type (judul hook) | Selalu untuk judul di babak pembuka/hook |
| 05 Digital zoom (ganti framing) | Rekaman statis/panjang tanpa potongan, atau saat kata penekanan |
| 09 Zoom-through cut | Ada perpindahan babak atau potongan take yang terasa kasar |

**Belum dibuat** — usulkan di rencana, buat hanya setelah user setuju (pakai skill `haidry`):

| Efek | Kondisi yang cocok untuk konversi |
|---|---|
| 07 Checklist | Kreator menyebut 2+ keunggulan berurutan (anti kusut, adem, flowy) |
| 11 Pull-back reveal | Ada close-up bahan lalu tampilan penuh — bukti kualitas |
| 04 Frame break | Kreator menyodorkan produk ke kamera |
| 06 Phone mockup | Ada tangkapan layar ulasan/halaman produk di `public/broll/` |
| 10 Chart grow | **Hanya** angka yang diucapkan atau tertulis di brief |
| Transisi flash | Pergantian varian warna cepat |

**Jangan**: 02 Couch wall, 08 Headline wall, 12 Green screen, 15 Vertigo (artefak di wajah/hijab atau butuh teks yang
tidak diucapkan). **Hindari**: 01 Orbit, 03 UI world, 14 Doodle boil.

## 6. CTA — dikondisikan sesuai video

Urutan memilih:
1. Kreator **mengucapkan CTA** → pakai ucapannya sebagai teks. Kalau isinya khusus satu platform (mis. "keranjang
   kuning"), versi Instagram menyembunyikan teks itu, memakai CTA IG, dan **laporkan** karena masih terdengar.
2. Tidak ada CTA terucap → pilih dari bank di bawah sesuai isi video, tulis alasannya.

| Kondisi | TikTok | Instagram |
|---|---|---|
| Umum | "Cek keranjang kuning sekarang" | "Cek link di bio" `[SEMENTARA]` |
| Brief menyebut promo | "Cek keranjang kuning, promonya terbatas" (hanya jika brief menyebut terbatas) | "Cek link di bio sebelum promonya habis" (syarat sama) |
| Brief menyebut **jadwal live** | "Join live jam <jam di brief>" | sama |

"Join Live" **hanya** jika brief menulis jadwal live (iklan tayang terus; tanpa jadwal, penonton bisa tidak menemukan live).

## 7. Visual brand

| Elemen | Nilai |
|---|---|
| Caption | Per kata, maks 3 kata per layar, font **Oswald**, cream `#FFFDD0`, outline hitam `#000000` 4 px, pop 0,1 dtk |
| Kata kunci | KAPITAL, teks hitam `#000000` di **kotak cream `#FFFDD0`** bersudut bulat. Komponen kotak belum ada → pakai cream lebih besar + outline hitam tebal dan laporkan |
| Kata kunci otomatis | Harga/promo (dari brief/ucapan), USP (anti kusut, adem, flowy, nge loose), nama produk & varian (`kamus_kata`); maks 1 per layar |
| Judul hook | Font **Anton**, cream di atas kotak hitam transparan, maks 6 kata, dari ucapan |
| Grafis tambahan | Hanya cream & hitam. **Dilarang merah, kuning, biru** |
| Logo | Kanan **atas**, lebar ±12% `[SEMENTARA — form tim menulis 25%, terlalu besar]`, sepanjang video |
| Outro | Video logo ending (`public/logo-ending.mp4`) jika ada; jika tidak, logo + `@aysillafactoryid` di latar hitam, 1,5–2 dtk |
| Grading | Hangat, natural, kulit tidak pucat, tidak over exposure |
| Emoji | Tidak dipakai |

## 8. Audio

- Suara kreator selalu paling jelas.
- SFX dari `public/sfx/`: pop (kata kunci), whoosh (transisi), ding, glitter; glitch maks 1× per video
  (gaya clean minimalis). Maks 1 SFX per 2 dtk. Tanpa suara kaget/kartun.
- Musik: pop ceria instrumental, hanya dari `public/musik/` **yang ada `lisensi.txt`**. Kosong → tanpa
  musik, laporkan.
- Loudness −14 LUFS, TP −1 dB (otomatis di `render.py`).

## 9. Aturan wajib

- Teks di layar hanya dari ucapan, brief, atau brand kit (handle, disclaimer). Tidak mengarang kalimat atau testimoni.
- Angka/harga hanya dari ucapan atau brief.
- Klaim boleh: bahan adem, tidak nerawang, ukuran M–XL, flowy, anti kusut, polyester premium, "Cuci Jemur Langsung Pakai".
- Dilarang tampil sebagai teks: "paling murah", "no. 1", superlatif di brand kit, klaim kesehatan, "gratis ongkir"
  tanpa promo di brief. Kalau terucap → sembunyikan dari caption dan laporkan.
- Visual dilarang: produk kompetitor, logo lain, aurat terbuka.
- Varian warna ditampilkan → tambah disclaimer kecil "Warna dapat sedikit berbeda karena cahaya".

## 10. Checklist QC

- [ ] Mode audio A; durasi mengikuti materi, penawaran & CTA di ekor utuh
- [ ] Hook ≤ 3 dtk dengan judul dari ucapan
- [ ] Ada bukti produk (try-on/detail/before-after) sesuai rekaman
- [ ] Harga/promo di layar **sama persis** dengan brief/ucapan; tidak ada urgensi karangan
- [ ] Ejaan sesuai `kamus_kata`; tidak ada superlatif/klaim terlarang di layar
- [ ] Caption maks 3 kata, di safe area, tidak menutup wajah/produk (cek frame)
- [ ] Warna grafis hanya cream & hitam; disclaimer warna ada jika varian ditampilkan
- [ ] Maks 3 jenis efek, alasan sesuai kondisi video tercatat
- [ ] CTA beli sesuai platform (`_tt` keranjang kuning, `_ig` tanpa keranjang kuning); "Join Live" hanya jika ada jadwal
- [ ] Logo kanan atas + outro; file `_tt` dan `_ig` versi baru, versi lama utuh
- [ ] MetaClean exit 0
