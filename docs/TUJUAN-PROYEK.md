# Tujuan Proyek Motion Studio

Pegangan tim. Disusun venus dari diskusi dengan owner, 15 November 2026. Keputusan tetap di owner.

## Visi
Standar editor dipindah ke mesin. Mesin terus belajar dari koreksi editor dan PIC sampai hasilnya serapi editan manusia. Editor tetap kreator: kerja santai, kualitas tinggi, jumlah banyak.

**Prinsip hybrid:** semua yang otomatis tetap bisa diubah manual. Mesin memberi usulan dan pengaman; manusia boleh menimpa, dan setiap timpaan dicatat supaya mesin belajar.

Pendekatan konten: **ATM** (Amati, Tiru, Modifikasi) untuk branding dan awareness.

## Masalah sekarang
1. Paling lama: memotong video dan mencocokkan dengan caption.
2. Target hanya 6 video per hari dan sering tidak tercapai. Hanya ada 1 editor; dia sangat bagus tapi teliti, jadi lambat.
3. Gaya edit beda-beda antar orang, dan biaya editor mahal.
4. Momen sering lewat (tren, promo, live) karena video telat.
5. Persetujuan (PIC) jadi bottleneck.

## Ukuran berhasil (3 bulan)
- **Nol pelanggaran** (konten tidak orisinal, brand lain, klaim terlarang).
- **Seragam**: branding, caption, dan gaya edit sama per brand, siapa pun yang mengerjakan.
- Video **winning**, bukan sekadar banyak.

## Batasan
- Alat internal. Tidak dijual atau disewakan.
- Tidak ada brand luar; owner akan membuat beberapa brand sendiri. Semua fitur harus berlaku untuk semua brand.
- Tidak ada upload otomatis. Aplikasi berhenti di hasil edit; PIC yang memutuskan layak tayang.
- Biaya seminimal mungkin. VPS dipakai bersama Affiliate. API AI murah dan akunnya banyak.
- Tidak memakai musik berlisensi. Voice over didahulukan.
- Orisinalitas wajib: konten benar-benar dicampur, dan bahan yang sudah dipakai tidak dipakai berulang, termasuk antar batch.
- Import dan export tidak boleh lambat untuk tim.

## Motion Transfer
Nama pola kerja Jika (dinamai owner, 15 Nov 2026):
1. Cari video referensi yang konsepnya mau ditiru.
2. Ambil gambar dari adegannya, lalu ganti produk di gambar itu dengan produk sendiri lewat AI gambar.
3. Gerakkan gambar itu lewat AI video supaya mirip video referensi.

Rencana: tahap 1–2 diuji dulu bersama Jika. Tahap 3 menyusul dengan batas biaya.

## Rencana perbaikan putaran 1 (R)
Status dicatat di `PROGRESS.md` bagian "Putaran R". Kolom "Isian tim" = hal yang harus diisi atau diputuskan orang, bukan kode.

### Hari ini
- [ ] R1 Generate menolak video yang audionya lagu (G1). Manual: job boleh "tetap lanjut".
- [ ] R2 Hook tidak menimpa teks bawaan video (G2). Manual: posisi hook tetap bisa digeser di editor.
- [ ] R3 Peringatan jelas kalau CTA Brand Kit kosong (G6).
- [ ] R4 Nomor job unik per brand per hari untuk semua proyek (G4).
- [ ] R5 Undo bekerja walau dilakukan cepat setelah ubah gaya.

### Minggu ini
- [ ] R6 Riwayat pakai per brand: shot dan susunan VO yang sudah dipakai di batch lain tidak keluar lagi.
- [ ] R7 Potong presisi: titik potong jatuh di jeda bicara, bukan di tengah kata.
- [ ] R8 Mesin otomatis memakai fade audio dan filter bawaan brand. Manual: semua tetap bisa diubah di Inspector.
- [ ] R9 Catatan belajar: setiap koreksi editor dan alasan tolak PIC disimpan per brand.
- [ ] R10 Layar persetujuan PIC: daftar video menunggu, putar, Setujui / Revisi + catatan.

### Sesudahnya
- [ ] R11 Motion Transfer tahap 1: ambil gambar per adegan dari video referensi secara otomatis.
- [ ] R12 Motion Transfer tahap 2: ganti produk di gambar lewat AI gambar (butuh akun API, lihat isian tim).
- [ ] R13 Brand baru cepat: duplikat Brand Kit dari brand yang ada.
- [ ] R14 Pratinjau resolusi kecil supaya cepat dibuka dari luar kantor.
- [ ] R15 Backup mingguan workspace.

## Isian tim (bukan kode)
| Isian | Siapa | Untuk |
|---|---|---|
| CTA Aysilla (2–3 kalimat ajakan) dan kata kunci produk | owner / PIC | R3, Generate dan Batch |
| Preset gaya Aysilla yang dikunci: font, warna caption, filter, posisi CTA | editor + owner | R8, R10 |
| Daftar alasan tolak PIC yang sering muncul | PIC | R9, R10 |
| 3–5 video referensi + foto produk untuk uji Motion Transfer | Jika | R11, R12 |
| Akun / API AI gambar yang boleh dipakai dan batas biaya per bulan | owner | R12 |
| Lokasi backup (disk lain / Google Drive) | owner | R15 |
| Nama dan identitas brand baru | owner | R13 |

## Tidak dikerjakan
Upload otomatis, fitur jual/sewa (SaaS), musik berlisensi.
