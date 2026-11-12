---
name: aysilla-versi-baru
description: Re-upload konten winning Aysilla Factory dengan aman — buat VERSI BARU (bukan upload ulang file) supaya tidak kena "Konten yang Tidak Orisinal" TikTok. Bedah formula video lama, tulis 3 naskah segar, cek naskah tidak mirip arsip, buat brief rekam ulang, lalu edit rekaman baru dengan skill aysilla-talkinghead dan bersihkan dengan MetaClean. Pakai saat user mau upload ulang / re-upload / repost / "pakai lagi" konten winning, minta versi baru atau variasi dari video lama, kena notifikasi konten tidak orisinal, atau mengirim video lama / unduhan TikTok/IG/YouTube untuk diunggah lagi. Contoh pemicu: "bikin versi baru dari video winning celana", "video ini kena konten tidak orisinal", "gua mau re-upload konten winning", "repost video yang laku kemarin", "upload lagi video ini", "dikurangi 20 poin konten tidak orisinal".
---

# Versi Baru dari Video Winning — Aysilla Factory

Versi **v0.2 (12 Nov 2026)**. Nilai bertanda `[SEMENTARA]` belum dikonfirmasi tim. Semua perintah dijalankan dari
`D:\VIBECODING\remotion`. Baca sekali di awal sesi: `references/kebijakan-orisinal.md` (kebijakan + sumber) dan
`references/templates.md` (bentuk file output).

## 0. Prinsip

TikTok menilai **isi** video (gambar + suara), bukan metadata. **Mengunggah ulang video lama sendiri dihitung tidak
orisinal**, walaupun file sudah dibersihkan MetaClean, di-rename, di-upscale, atau dibuat 60 fps. Pelanggaran
menumpuk (laporan: 6× dalam 90 hari bisa mencabut izin e-commerce).

Yang dipakai ulang dari video winning hanya **formulanya**: hook, urutan argumen, klaim produk, durasi, gaya bicara.
Yang harus **baru**: naskah (kalimat), rekaman (gambar), susunan edit.

### Kalau user bilang "mau re-upload konten winning"

Tujuannya sah (konten itu terbukti menjual). Jawab jujur dan singkat, lalu **langsung kerjakan** Mode A:

> "Re-upload file yang sama hampir pasti kena 'Konten yang Tidak Orisinal' lagi dan poinnya menumpuk. Yang kita
> re-upload adalah **formulanya** — hook, klaim, dan struktur yang sudah terbukti — dengan naskah dan rekaman baru.
> Aku bedah videonya sekarang dan siapkan 3 naskah + shot list."

Jangan berhenti di penolakan, dan jangan menjanjikan versi baru pasti lolos.

## 1. Larangan keras

Kalau diminta, **jangan kerjakan**; jelaskan TikTok menghukum teknik ini, lalu tawarkan Mode A.
- Upload ulang file lama dengan perubahan kosmetik: rename, strip metadata, upscale, 60 fps, potong awal/akhir, ganti
  musik, tambah teks/stiker/logo/watermark.
- Penyamaran: mirror/flip, crop/zoom, ubah kecepatan, filter/warna, noise/grain, border, **sandwich frames** (klip lain
  di atas/bawah), **sisip frame kilat**, gambar tak terkait di dalam video.
- Footage, suara, atau naskah kreator/brand lain tanpa izin tertulis.
- Musik di luar `public/musik/`.
- Suara AI/TTS menggantikan suara orang `[SEMENTARA]`: tanya user dulu.
- Unduhan TikTok/IG (ada ID platform, watermark, atau MetaClean mendeteksinya sebagai TikTok/Instagram) **tidak boleh
  dipakai sebagai footage**, hanya untuk dibedah.

## 2. Persiapan (sekali per sesi)

1. **Tentukan mode.** Ada rekaman yang direkam **setelah** video lama (tanya kalau ragu) → Mode B. Selain itu → Mode A.
2. **Isi arsip naskah yang sudah terbit.** `cek_orisinal.py` hanya bisa menolak naskah yang mirip dengan yang ada di
   `arsip/terbit/`. Kalau arsip kosong atau video lama belum tercatat, catat dulu transkrip video winning (dan video
   lain yang sudah terbit, kalau ada):
   ```
   .venv\Scripts\python pipeline\cek_orisinal.py catat out\<nama>\lama\transkrip.json --id <nama>_lama --catatan "<produk>, sudah terbit"
   ```
3. **Banyak video sekaligus** (mis. folder berisi puluhan video winning): jangan kerjakan semuanya. Minta data kinerja
   (views/penjualan) dan pilih **3–5 teratas** `[SEMENTARA]`; satu video lama → satu folder `out/<nama>/` → 3 naskah.
   Laporkan sisanya sebagai antrean.

## 3. Mode A — Bedah formula & brief rekam ulang

1. **Transkrip video lama** (salin dulu ke `public/masuk/lama/<nama>.mp4`):
   ```
   .venv\Scripts\python pipeline\transcribe.py public\masuk\lama\<nama>.mp4 out\<nama>\lama\transkrip.json --brandkit brandkit\aysilla.json
   ```
   Lalu catat ke arsip (bagian 2.2) kalau belum.
2. **Ambil 3 frame video lama** (detik 1, tengah, akhir) dan lihat gambarnya untuk mencatat visualnya:
   `ffmpeg -v error -y -ss <detik> -i public\masuk\lama\<nama>.mp4 -frames:v 1 out\<nama>\lama\f_<detik>.jpg`
3. **Tulis `out/<nama>/formula.md`** (template di `references/templates.md`): hook + jenisnya, struktur per babak
   dengan detik, klaim produk + sumbernya, visual lama, dugaan kenapa winning (sebagai dugaan), data kinerja kalau ada.
4. **Tulis 3 naskah** `out/<nama>/naskah_1.txt` … `naskah_3.txt`:
   - Hook **berbeda jenis** dari video lama dan dari naskah lain (pertanyaan, keluhan pembeli, demo langsung,
     sebelum/sesudah, angka dari brief).
   - Urutan atau sudut pandang berbeda. Klaim boleh sama, **dengan kalimat sendiri**.
   - Fakta, harga, promo hanya dari brief, brand kit, atau ucapan video lama. Tanpa testimoni/angka karangan.
   - Tanpa kata di `superlatif_dilarang` brand kit.
   - 40–75 kata ucapan (15–30 dtk) `[SEMENTARA]`; CTA sesuai placement (TikTok: "Cek keranjang kuning sekarang").
   - Arahan di dalam `[kurung siku]`; `cek_orisinal.py` mengabaikannya.
5. **Cek tiap naskah** (terhadap arsip + video lama):
   ```
   .venv\Scripts\python pipeline\cek_orisinal.py cek out\<nama>\naskah_1.txt --banding out\<nama>\lama\transkrip.json
   ```
   Wajib **OK** (< 40%). HATI-HATI → tulis ulang kalimat yang ditunjuk, cek lagi. TOLAK → tulis ulang dari awal.
   Cek juga antar naskah baru: `--banding out\<nama>\naskah_2.txt out\<nama>\naskah_3.txt` (3 naskah tidak boleh
   saling mirip, karena ketiganya akan terbit).
6. **Tulis `out/<nama>/brief_rekam.md`** (template di `references/templates.md`). Tiap naskah wajib punya **minimal 4
   perbedaan visual** dari video lama: latar/lokasi, susunan display produk, outfit atau varian/warna produk,
   angle/jarak kamera, demo baru, cahaya/waktu. Orang tetap tampil bicara ke kamera.
7. **Kirim ke user**: formula singkat (5 baris), 3 naskah + persen hasil cek, ringkasan shot list, properti yang perlu
   disiapkan. **Berhenti.** Lanjut ke Mode B setelah rekaman baru masuk ke `public/masuk/<nama>_n1.mp4` dst.

## 4. Mode B — Edit versi baru dari rekaman baru

1. **Pastikan rekamannya baru**: bukan potongan file lama; sesuai shot list (latar/angle beda). File lama → Mode A.
2. **Edit dengan skill `aysilla-talkinghead`** (langkah 1–8: cek input, transkrip, `edit.py`, rencana + tunggu
   konfirmasi, revisi, render draf, render final, QC frame). Semua aturannya berlaku. Tambahan di rencana edit:
   sebutkan **apa yang berbeda dari video lama** (hook, urutan, visual, efek).
3. **Cek orisinalitas transkrip hasil** sebelum render final:
   ```
   .venv\Scripts\python pipeline\cek_orisinal.py cek out\<nama>_n1\transkrip.json --banding out\<nama>\lama\transkrip.json
   ```
   Harus **OK**. Kalau talent mengucapkan ulang kalimat lama persis → laporkan; perbaikannya rekam ulang kalimat itu.
4. **Footage lama tidak dipakai.** (Komposisi `AdVideo` memang hanya satu sumber video. Menyisipkan footage lama butuh
   komposisi baru dan izin user; kalaupun dibuat: hanya dari file master, ≤ 20% durasi, dengan ucapan baru
   `[SEMENTARA]`.)
5. **MetaClean** (langkah terakhir sebelum upload, perintah persis di skill `aysilla-talkinghead` langkah 9). Exit 0.
6. **Setelah user mengunggah**, catat naskahnya supaya versi berikutnya tidak mengulang:
   ```
   .venv\Scripts\python pipeline\cek_orisinal.py catat out\<nama>_n1\transkrip.json --id <nama>_n1 --catatan "<produk>, terbit <tanggal>"
   ```

## 5. Checklist orisinalitas (wajib lulus sebelum lapor selesai)

- [ ] Video berasal dari **rekaman baru** (bukan file/unduhan lama yang diedit)
- [ ] Video lama sudah tercatat di arsip; `cek_orisinal.py cek` = **OK** terhadap arsip, video lama, dan naskah saudaranya
- [ ] Hook berbeda jenis dari video lama
- [ ] Minimal 4 perbedaan visual dari video lama
- [ ] Orang tampil di kamera, bicara dengan kalimat sendiri
- [ ] Footage lama tidak dipakai
- [ ] Tidak ada teknik di bagian 1
- [ ] Musik hanya dari `public/musik/` atau tanpa musik
- [ ] Checklist QC `aysilla-talkinghead` lulus
- [ ] MetaClean exit 0 (CLEAN)

## 6. Laporan

**Mode A**: formula (5 baris), 3 naskah + persen kemiripan, ringkasan shot list & perbedaan visual, properti, nama file
yang harus dipakai saat menaruh rekaman. **Mode B**: laporan `aysilla-talkinghead` + checklist orisinalitas + hasil
MetaClean + perintah `catat` yang dijalankan setelah upload.

Selalu jujur: skill ini **mengurangi** risiko, tidak menjamin lolos. Moderasi TikTok otomatis dan bisa salah tandai.
Kalau konten benar-benar baru tapi tetap ditandai, banding dengan bukti (rekaman mentah, file project, `brief_rekam.md`).
