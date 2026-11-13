# Brand Kit Lengkap — isian tim per brand

Versi: 13 November 2026 · untuk Motion Studio (satu aplikasi) · mengadaptasi Brand Kit X06 + Brand guard X08

## Prinsip

- **Satu Brand Kit per brand.** Tim memilih brand saat membuat video, lalu semua aturan brand itu dipakai otomatis: Generate Otomatis, Batch Remix, preset teks Editor, Copilot, dan brand guard sebelum render.
- **Diisi sekali, dipakai terus.** Tim mengisi Brand Kit saat brand baru masuk. Setelah itu yang diisi per video hanya brief singkat (bagian G).
- **Isi yang konkret.** Tulis "maks 3 kata", bukan "jangan banyak". Kalau ragu, tulis "belum tahu" daripada menebak, karena mesin akan mengikuti tebakan yang salah.
- **Tim tidak perlu mengisi** hal yang dikerjakan mesin (bagian H).

Kolom **Wajib**: ✅ = harus diisi sebelum brand bisa dipakai · ◻ = opsional.
Kolom **Motion Studio**: **ada** = sudah dibangun di X06/X08 · **sebagian** = ada tapi kurang · **belum** = perlu ditambah.

## A. Identitas brand

| Isian | Wajib | Contoh (Aysilla Factory) | Dipakai otomatis untuk | Motion Studio |
| --- | --- | --- | --- | --- |
| Nama brand | ✅ | Aysilla Factory | Judul, nama file, outro | ada |
| Kode brand (3–4 huruf) | ✅ | AYS | ID job & nama file (`AYS-20261113-001`) | belum |
| Handle per platform | ✅ | TikTok @aysillafactoryid · IG @aysillafactoryid | Outro, teks penutup | belum |
| Target penonton | ✅ | Wanita 20–35, kantoran, suka celana yang nggak panas | Pilihan hook & kata kunci oleh AI | belum |
| Nada bicara (3 kata) | ✅ | Santai, meyakinkan, ceria | Gaya teks hook & CTA oleh AI | belum |
| Bahasa teks | ✅ | Campur (gaul sopan) | Ejaan teks di layar | belum |
| Daftar produk | ✅ | Loose Pants (M–XL; Espresso, Black, Ivory, Latte, Smoke Grey) · Lucy Pants · Kulot | Ejaan nama produk, pilihan produk di brief, kata kunci | belum |

## B. Visual

| Isian | Wajib | Contoh | Dipakai otomatis untuk | Motion Studio |
| --- | --- | --- | --- | --- |
| Warna utama + aksen (HEX, maks 6) | ✅ | #FFFFFF, #000000 | Preset teks, kata kunci, kotak judul | ada (`colors`) |
| Warna teks caption | ✅ | #FFFFFF | Caption per kata | ada (`text_color`) |
| Warna outline + tebal | ✅ | #000000, 4 px | Caption terbaca di atas video | belum |
| Warna dilarang | ◻ | merah, kuning, biru | Brand guard: tolak preset dengan warna ini | belum |
| Font judul (file .ttf/.otf atau nama Google Font) | ✅ | Anton | Hook, judul, CTA | sebagian (baru 1 font) |
| Font caption | ✅ | Oswald | Caption per kata | sebagian (baru 1 font) |
| Logo utama (PNG transparan, ≥1000 px) | ✅ | logo.png | Logo di video & outro | ada |
| Logo versi terang (untuk latar gelap) | ◻ | logo-putih.png | Dipilih otomatis sesuai terang/gelap video | belum |
| Posisi, ukuran, opasitas logo | ✅ | Kanan atas, 25%, 100% | Penempatan logo | ada |
| Kapan logo tampil | ✅ | Sepanjang video + penutup 2 dtk | Penempatan logo | sebagian (saklar per proyek) |
| Video/animasi penutup | ◻ | outro-aysilla.mp4 (2,5 dtk) | Penutup otomatis | belum |
| Gaya keseluruhan | ✅ | Clean minimalis | Pilihan efek & preset | belum |
| Color grading | ◻ | Hangat, natural, kulit tidak pucat | Filter warna otomatis | belum |

## C. Teks & bahasa

| Isian | Wajib | Contoh | Dipakai otomatis untuk | Motion Studio |
| --- | --- | --- | --- | --- |
| CTA per platform | ✅ | TikTok/Shopee "Cek keranjang kuning sekarang" · IG "Cek link di bio" | Teks CTA & outro sesuai placement | belum |
| Kalimat CTA wajib (kalau ada) | ◻ | "Penasaran sama celana anti kusut ini?" | CTA ucapan yang wajib ada | belum |
| Disclaimer + kapan tampil | ◻ | "Warna dapat sedikit berbeda karena cahaya", saat video memperlihatkan varian warna | Teks kecil di bawah | belum |
| Kosakata Whisper | ✅ | Aysilla Factory, Loose Pants, high waist, flowy, anti kusut | Transkrip tidak salah dengar | belum |
| Kamus kata (salah → benar) | ✅ | Icila Factory → Aysilla Factory · Luspents → Loose Pants | Koreksi ejaan otomatis | belum |
| Kata kunci yang diperbesar | ✅ | anti kusut, flowy, adem, high waist, nama produk | Kata kunci di caption | belum |
| Aturan huruf kapital | ✅ | Kata kunci KAPITAL, sisanya normal | Caption | belum |
| Emoji di teks | ✅ | Tidak | Caption & Copilot | belum |

## D. Aturan & brand guard

| Isian | Wajib | Contoh | Dipakai otomatis untuk | Motion Studio |
| --- | --- | --- | --- | --- |
| Kata / klaim terlarang | ✅ | paling murah, termurah, no. 1, **belum ada yang ngalahin**, klaim kesehatan | Diblokir dari teks; kalau terucap, diberi peringatan atau dipotong | ada (`guard.banned`) |
| Level pelanggaran | ✅ | Blokir | Render diblokir atau hanya peringatan | ada (`banned_level`) |
| Harga promo + tanggal berlaku | ◻ | "80rb-an" s/d 30 Nov 2026 | Harga kedaluwarsa memblokir render | ada (`guard.prices`) |
| Klaim yang BOLEH | ✅ | bahan adem, tidak nerawang, ukuran M–XL, anti kusut | Teks & hook AI hanya boleh memakai klaim ini | belum |
| Visual dilarang | ◻ | produk kompetitor, logo lain, aurat terbuka | Peringatan untuk QC manual | belum |
| Area yang tidak boleh tertutup teks | ✅ | wajah, produk, 15% bawah, sisi kanan (tombol) | Posisi caption otomatis | belum |

Catatan uji 13 Nov: frasa superlatif seperti "belum ada yang ngalahin" lolos karena daftar lama hanya berisi "paling murah", "no. 1". Daftar kata terlarang perlu memuat variasi superlatif.

## E. Aset brand

| Isian | Wajib | Syarat | Dipakai otomatis untuk | Motion Studio |
| --- | --- | --- | --- | --- |
| SFX | ✅ | Minimal pop + whoosh. MP3/WAV < 1 dtk, beri tag (`teks-muncul`, `transisi`, `penutup`) | SFX dipasang sesuai tag | belum (library media umum, tanpa tag brand) |
| SFX dilarang | ◻ | Suara kaget keras, efek kartun | Disaring dari pilihan | belum |
| Musik latar | ◻ | Instrumental. **Wajib bukti lisensi** untuk iklan berbayar. Tag mood & BPM | Musik otomatis; tanpa lisensi tidak bisa dipilih | belum |
| B-roll produk | ◻ | MP4 vertikal / foto ≥1080 px, beri tag (`detail-bahan`, `try-on`) | Sisipan shot & Batch Remix | belum |
| Video referensi winning (min 3) | ✅ | Link + apa yang ditiru / tidak ditiru | Acuan gaya untuk preset & AI | belum |

## F. Preset per jenis konten

Satu brand bisa punya beberapa preset, misalnya `aysilla-konversi`, `aysilla-awareness`, `aysilla-branding`, `aysilla-tryon`. Preset dipilih di brief, lalu semua isian di bawah dipakai otomatis.

| Isian | Wajib | Contoh |
| --- | --- | --- |
| Jenis & tujuan | ✅ | Konversi · jualan langsung |
| Placement dipakai + durasi target | ✅ | TikTok 20 dtk · Shopee 20 dtk (min 15, maks 30) |
| Versi turunan otomatis | ✅ | 9:16 master + 4:5 + cover |
| Struktur babak (detik + isi) | ✅ | Hook 0–3 · Masalah 3–7 · Bukti 7–20 · Penawaran 20–25 · CTA 25–30 |
| Ritme | ✅ | Ganti shot tiap 2–5 dtk · jeda maks 0,5 dtk · selalu pakai take terakhir yang bersih |
| Caption | ✅ | Per kata · maks 3 kata · pop 0,1 dtk |
| Teks hook | ✅ | Ya, maks 6 kata, harus dari ucapan |
| 17 efek: Wajib / Boleh / Jangan + maks per video + jarak | ✅ | Glass type wajib di hook · digital zoom & zoom-through boleh · maks 3 · jarak 5 dtk |
| Audio | ✅ | Suara asli · SFX tiap teks besar & transisi · musik di bawah suara · −14 LUFS |
| Checklist QC (otomatis / manual) | ✅ | 12 butir, mis. durasi, hook 3 dtk, ejaan, harga = brief, teks tidak menutup wajah |

## G. Brief per video (diisi tiap upload, < 1 menit)

| Isian | Wajib | Contoh |
| --- | --- | --- |
| Brand | ✅ | Aysilla Factory (pilih) |
| Preset | ✅ | aysilla-konversi (pilih) |
| Produk & varian | ✅ | Loose Pants, Espresso (pilih dari daftar produk) |
| Harga / promo (tulis persis, boleh kosong) | ◻ | 80rb-an |
| Placement | ✅ | TikTok |
| Catatan / pengecualian | ◻ | Tambah transisi flash |

Harga dan angka hanya tampil kalau ditulis di brief atau diucapkan di video.

## H. Yang dikerjakan mesin (tim tidak mengisi)

Transkrip, buang jeda & take ulang, pilih hook, pilih kata kunci, posisi caption yang aman, pasang SFX & efek sesuai preset, musik sesuai mood, logo & outro, cek brand guard, QC otomatis, render, hapus metadata. Hasilnya muncul sebagai **rencana edit** yang disetujui tim sebelum render; editor hanya turun tangan untuk finishing.

## Celah Motion Studio yang perlu ditambah

1. **Multi-brand.** Brand Kit X06 sekarang satu per workspace (`brand_kit.json`). Perlu banyak Brand Kit, dipilih per proyek. Ini yang paling besar.
2. **Font judul + font caption** (sekarang satu font).
3. **Bagian A, C, E, F** hampir semua belum ada: handle, CTA per platform, kosakata Whisper, kamus kata, kata kunci, klaim boleh, aset bertag per brand, preset per jenis konten.
4. **Brand guard**: tambah klaim boleh, warna dilarang, area yang tidak boleh tertutup.
5. **Mesin Generate Otomatis & Batch Remix** membaca Brand Kit ini, bukan `brandkit/*.json` sendiri. File `brandkit/aysilla.json` dipindah sebagai data awal brand Aysilla.
