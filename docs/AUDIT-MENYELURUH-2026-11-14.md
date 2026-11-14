# Audit menyeluruh Motion Studio: 14 November 2026

**Ringkasnya:** Motion Studio bisa dipakai.

- Semua menu sudah ditelusuri di situs online, di desktop dan di HP.
- Semua tes otomatis hijau.
- Sudah diperbaiki: sekitar 60 bug, termasuk 7 bug berat. Contohnya:
  - Iklan Batch Remix bisa lolos QC walaupun suaranya menyebut toko lain.
  - Subtitle berkotak hasil render berbeda dengan pratinjau.
  - Ketikan di Inspector bisa tersimpan ke klip lain.
- Belum teruji di situs online: alur **Generate Otomatis → rencana → render uji → unduh**, karena menunggu owner memilih file klip uji.
- Ada beberapa hal yang butuh keputusan owner (bagian 5).

Pembagian kerja:
- Jenius: koordinasi dan audit.
- ucok: aplikasi.
- yuki: mesin Batch Remix.
- sukma: uji online.
- venus: operasional server.

Semua perbaikan sudah di-commit **lokal**. Push menunggu venus dan izin owner.

Tingkat temuan:
- **Berat:** hasil atau data salah, atau alur buntu.
- **Sedang:** mengganggu kerja.
- **Ringan:** kosmetik atau jarang terjadi.

Status temuan:
- ✅ diperbaiki, dengan tes regresi kecuali ada catatan lain;
- ⏳ belum;
- ❓ keputusan owner.

---

## 1. Bukti jalan

| Uji | Hasil |
| --- | --- |
| `npm run verify` awal (18.40) | hijau. Core 288 lulus (1 dilewati), server 104, web 12, smoke OK |
| `npm run verify` akhir (19.4x, setelah semua commit) | hijau. Core 289 lulus (1 dilewati), server 112, web 17, smoke OK |
| `npm run test:ui` akhir (Chrome, W05…U8) | **338 PASS, 0 FAIL**, termasuk W15 E2E online 16/16 |
| Audit UI baru `audit/A14` (khusus temuan audit ini) | **27/27 lulus** |
| `audit/E2E/e2e.mjs` | 18/18 PASS |
| Tes mesin Batch Remix | 35/35 lulus |
| Uji nyata situs online (desktop 1400 px dan HP 375 px, owner login) | semua menu ditelusuri; Batch Remix sampai rencana 3 varian (sekitar 1 menit) |
| Uji nyata mesin Batch Remix dari baris perintah (tanpa render) | sesuai kontrak: `daftar_batch`, `batch`, `pisah`, dan batch yang tidak ada (ditolak, kode 2) |
| Generate Otomatis → rencana → render uji → unduh di situs online | **belum**: menunggu owner memilih file klip uji di browser QA |
| Tombol Keluar di situs online | **belum**: sengaja tidak diklik, karena login ulang butuh owner |

Catatan:
- Tidak ada render video jualan selama audit.
- Verify akhir dijalankan dengan perbaikan visuals ucok di working tree (`packages/core/src/storage/visuals.ts` dan tes paket1). Perbaikan itu belum di-commit dan masih menunggu izin owner, tapi **sudah ikut ter-build dan aktif di server online** sejak restart 19.13. Lihat bagian 5.

---

## 2. Temuan per menu

### Situs online dan operasional
- **[Berat] Situs mati (502) sekitar 18.34–18.41.** ⏳ sebagian ditangani.
  - Server dan proses penjaganya hilang, dan task server berhenti di status *Ready*. Sukma menyalakannya lagi pukul 18.42.
  - **Penyebab tidak bisa dibuktikan.** Tidak ada skrip uji di repo yang memakai port server atau mematikan proses. Log Task Scheduler di PC kantor nonaktif.
  - Log penjaga ternyata gagal menulis sejak 16.47, karena file log dikunci oleh pengalihan output. **Venus sudah memperbaikinya** (`deploy/windows`, belum di-commit):
    - output per jalan ditulis ke file sendiri;
    - catatan penjaga memakai akses berbagi;
    - log lebih dari 7 hari dihapus;
    - sudah diuji: Node dimatikan, kejadiannya tercatat, lalu hidup lagi dalam 10 detik.
  - Watchdog dan log Task Scheduler menunggu izin owner (bagian 6).
- Restart server oleh venus (tanpa job yang jalan): 19.13 dan 19.32. Dua-duanya memuat perbaikan audit.

### Generate Otomatis
- **[Berat] Progres job berhenti selamanya setelah satu kali cek status gagal**, misalnya saat terowongan tersendat. ✅
  - Lokasi: `apps/web/src/views/GenerateView.tsx` (useEngineJob, juga dipakai Batch dan Pisah Audio).
  - Perbaikan: terus mencoba dengan jeda bertambah. Tes A14-12.
- **[Berat] Draf dari job lain bisa diterapkan**, kalau "Lihat" job B diklik saat rencana job A masih dimuat. ✅
  - Jawaban basi sekarang dibuang. Penjaga `readyJobShown`, tes di `apps/web/test/lib.test.ts`.
- [Sedang] Start mesin yang gagal meninggalkan proyek kosong. ✅ Proyek dipakai ulang saat diulang. Tes A14-11b.
- [Ringan] "Buat brand dulu di menu Brand." muncul sebelum daftar brand termuat. ✅ Sekarang tampil "Memuat brand…". Tes A14-17.
- [Ringan] Dua klik "Jalankan" bersamaan di proyek yang sama memberi error 500. ✅
  - Lokasi: `apps/server/src/engine.ts`, `packages/core/src/storage/engine.ts`.
  - Tes: `apps/server/test/audit-engine.test.ts`.
- [Ringan] Membatalkan job yang masih antre menampilkan pesan "server dimulai ulang". ✅ Sekarang "Dibatalkan pengguna sebelum mulai".
- [Ringan] Saat diulang setelah gagal, proyek dipakai ulang dengan **nama lama**, walau field nama sudah diubah. ⏳
- [Info] Peran Reviewer tidak bisa membuka rencana Generate.
  - Membuka rencana ikut mengimpor media mesin ke workspace (operasi tulis), jadi ini memang dibatasi untuk Owner/Editor.
  - Teks penjelasan untuk Reviewer sudah diperbaiki. Tes `apps/server/test/u7.test.ts`.

### Batch Remix (aplikasi + mesin)
- **[Berat] Varian Aysilla berisi VO yang menyebut toko lain** ("Ini Loose Pants dari … Store"), tetapi QC ✓ dan tombol Setujui aktif. ✅ (yuki)
  - Detektor baru `pipeline/batch/brand_lain.py` di repo mesin. Nama brand tidak ditulis di kode. Sumbernya:
    - semua `brandkit/*.json` selain brand job;
    - akun watermark footage;
    - pola "<nama> store/shop" yang tahan salah eja Whisper.
  - Kalimat yang kena dibuang sebelum dipilih. QC punya cek baru `brand_lain` sebagai jaring kedua.
  - Uji nyata di batch video winning: 14 dari 151 kalimat ditandai, semuanya benar. Varian hasilnya lulus QC tanpa nama toko lain.
  - Frasa umum seperti "fashion store" dan "outfit shop murah" tidak ikut tertandai (revisi setelah audit).
- [Sedang] Shot Library: semua 28 shot di batch gerbang1 berlabel `teks_bawaan`, karena judul buku di rak latar ikut terbaca OCR. ✅ (yuki)
  - Akibatnya nyata: shot ber-label itu dibuang Matcher saat hak pakai belum jelas, jadi 0 dari 28 shot bisa dipakai.
  - Teks kecil atau diam di footage satu take sekarang berlabel `teks_latar` (tetap di-blur).
  - gerbang1 sudah dibangun ulang. Batch video winning **belum** (sekitar 1 jam, lihat bagian 5).
- [Sedang] Path Python Windows tertanam di kode, sehingga Batch Remix tidak jalan di Linux (VPS jalur B). ✅ (yuki) Modul `pipeline/batch/jalur.py`, bisa diatur lewat env `MOTION_BATCH_PY` / `MOTION_BATCH_VENV`.
- [Sedang] Footage dengan spasi atau nama panjang dibuang aplikasi tanpa pesan (unggah lewat baris perintah). ✅ (yuki) Nama dibuat aman dan unik.
  - Jenius menemukan bug lanjutan: nama 40 karakter yang punya duplikat bisa menimpa hasil file lain. Ini juga sudah diperbaiki.
- [Ringan] Path di `shots.json` absolut dengan huruf drive, dan mesin bergantung pada folder kerja. ✅ (yuki) Sekarang relatif ke root mesin.
- [Ringan] Form "Susun batch" kembali ke bawaan setelah pindah menu. Centang "Hak pakai" tampak kosong lagi, sehingga owner ragu apakah ikut terkirim. ✅
  - Isian bertahan selama sesi.
  - Kartu job menampilkan "Dikirim ke mesin: … hak pakai jelas: ya/tidak …".
  - Tes A14-19 dan U8-09b.
- [Ringan] Tabel batch bisa memuat job lain, dan muncul error palsu "batch.json belum ada" saat pindah batch. ✅ (tinjau kode)
- [Ringan] Persetujuan batch bisa mengimpor media dari job yang belum siap atau gagal. ✅ Lokasi `packages/core/src/storage/service.ts`, tes `u8-batch-library`.
- [Ringan] `nama_unik` di mesin mengurutkan nama secara abjad. Kalau file baru ditambah lewat baris perintah, akhiran nama file lama bisa bergeser. ⏳ Jalur aplikasi tidak terdampak.

### Shot
- [Ringan] Halaman kosong 3–4 detik tanpa tanda memuat. ✅
- [Ringan] Label campur bahasa Inggris (full_body, closeup_produk, …). ✅ Sekarang bahasa Indonesia.
- [Ringan] Teks OCR mentah ("PTIlcIous VOGUI") tampil ke editor. ✅ Diganti "ada teks di gambar". Tes U8-04.
- [Ringan] Nomor halaman tidak dibatasi setelah filter. ✅ (tinjau kode)

### Editor
- **[Berat] Pratinjau caption per kata (pop/sorot/subtitle bertimecode) tampil 11 px abu-abu.** ✅ Penyebabnya aturan CSS `.canvas span`. Tes A14-01.
- **[Berat] Ketik di Inspector lalu klik klip lain menyimpan nilai ke klip lain.** ✅ Tes A14-02.
- **[Berat] Hasil render subtitle berkotak pekat dan melebar per kata**, padahal pratinjau 62 % selebar baris. ✅
  - "Pop" pada teks biasa juga tidak bekerja di render.
  - Lokasi: `packages/core/src/storage/ass.ts`.
  - Tes `u3b-word-captions` diperketat. Ekspektasi lama justru mengunci bug ini.
- [Sedang] Editor bisa merender **varian yang belum disetujui**. ✅
  - Sekarang 409 dengan alasan yang jelas, dan tombol Render mati beserta tooltip-nya.
  - Lokasi: `apps/server/src/routes.ts`. Tes `x09.test.ts`.
- [Sedang] Dialog (Render, Transkrip, Varian, Hapus permanen) mencuri fokus di setiap ketukan. ✅ Lokasi `apps/web/src/ui.tsx`, tes A14-05 dan A14-13.
- [Sedang] "+ Teks / + Subtitle" error kalau playhead sudah berisi klip. ✅ Tes A14-04.
- [Sedang] Fokus lalu keluar dari "Kata kunci disorot" membuat revisi kosong, dan varian yang sudah disetujui jadi "diubah". ✅ Tes A14-03.
- [Sedang] Gaya atau volume hilang kalau klip dilepas kurang dari 0,45 detik setelah diubah. ✅ Tes A14-14.
- [Ringan] Field "Mulai" yang dikosongkan memindahkan klip ke 0 detik. Koma desimal juga sekarang diterima. ✅
- [Ringan] Jawaban proyek lama menimpa proyek baru kalau pindah cepat. ✅ Tes A14-24.
- [Ringan] Teks yang di-drag kembali ke posisi lama sampai server menjawab. ✅ Tes A14-23.
- [Ringan] ⏮ dan timecode komentar tidak bekerja saat video diputar. ✅ Tes A14-22.
- [Ringan] Mengubah zoom membatalkan pilihan klip. ✅ Tes `keepSelection`.
- [Ringan] Link stream kedaluwarsa setelah 10 menit. ✅ (tinjau kode) Link diambil ulang saat media error.
- [Ringan] HP: tombol CC di daftar media terpotong. ✅ Tes A14-18.
- [Sedang] Crop tidak tampil di pratinjau Safari/iOS dan Firefox (`object-view-box`). ⏳ Butuh pengganti CSS dan uji di WebKit/Firefox. Lokasi `apps/web/src/views/Preview.tsx`.
- [Ringan] Undo kurang dari 0,45 detik setelah mengubah gaya: gaya tersimpan lagi. ⏳
- [Sedang] Pratinjau di situs online sangat lambat: setelah 14 detik buffer baru 0,68 detik, dan stream berkali-kali diulang. ❓ Lihat bagian 5.

### Media
- [Sedang] Antrean upload hilang kalau pindah halaman, dan upload berikutnya kena BUSY. ✅ Tes A14-16.
- [Sedang] Upload besar tampil "gagal" padahal berhasil. ✅
  - Penyebab: idle timeout 2 menit saat hashing.
  - Lokasi: `apps/server/src/routes.ts`. Tes `audit-upload.test.ts`.
- [Sedang] Tombol tidak sesuai peran, sehingga Reviewer melihat Import, lalu kena 403. ✅ (tes tipe; audit UI per peran butuh login pengganti)
- [Ringan] Tidak ada filter jenis, dan daftar didominasi 100 SFX. ✅ Filter Video / Audio / Gambar & lainnya.
- [Ringan] Pilihan di HP keluar layar. ✅ Tes A14-20.

### Brand
- [Sedang] Upload di Brand menimpa editan yang dibuat selama upload. ✅ Tes A14-08b.
- [Sedang] Pindah brand atau "+ Brand baru" membuang editan tanpa peringatan. ✅ Sekarang ada konfirmasi. Tes A14-21.
- [Sedang] Pesan seperti "Pilih file font .ttf atau .otf." tampil sebagai "kesalahan yang tidak dikenal". ✅ Tes A14-08.
- [Ringan] Preset baru bisa mendapat id ganda, sehingga simpan gagal. ✅
- [Sedang] **Brand Kit Aysilla di Motion Studio hampir kosong.** ❓ Bagian 5.
  - Yang kosong: handle, CTA, font, logo, klaim, warna dilarang, kosakata Whisper, kamus.
  - Akibatnya brand guard tidak memblokir apa pun, varian tanpa CTA/handle, dan transkrip salah ("Modalnya" untuk "Modelnya", "Gerat" untuk "Gerak") masuk ke caption.
- [Sedang] Asset Library belum punya musik, sehingga semua varian Batch Remix tanpa musik. ❓

### Trash
- **[Berat] Kotak frasa "Hapus permanen" kehilangan fokus di setiap huruf.** ✅ Tes A14-05 dan A14-13.
- [Sedang] Dialog hapus buntu setelah gagal atau kedaluwarsa. ✅ Sekarang ada "Tutup" dan "Siapkan permintaan baru". Tes A14-06 dan A14-07.
- [Sedang] Editor melihat "Hapus permanen", dan Reviewer melihat "Pulihkan", lalu keduanya kena 403. ✅
- [Ringan] Alasan blokir masih berupa kode mentah. ✅ Sekarang berupa kalimat.

### Storage
- [Ringan] Kandidat Auto Trash hanya menampilkan id versi tanpa nama file. ✅
- [Ringan] `audit_limit 0` mengembalikan seluruh log. ✅ Tes `st10-quota-dashboard`.
- [Sedang] **Backup terverifikasi 0/104**: belum ada lokasi backup sama sekali. ❓

### AI dan Copilot
- [Sedang] Satu provider tanpa harga atau lewat anggaran memblokir semua AI, tanpa failover. ✅
  - Lokasi: `apps/server/src/ai/router.ts`. Tes `w13`.
- [Sedang] Form "Tambah koneksi" dan "Ganti key" terhapus walau simpan gagal. ✅ Tes A14-09.
- [Sedang] Koma desimal ditolak ("0,5"), dan batas yang kosong tersimpan sebagai 0 sehingga semua AI terblokir. ✅ Tes A14-10 dan A14-11.
- [Sedang] Diff Copilot tetap menampilkan langkah yang tidak akan diterapkan kalau hanya sebagian dicentang. ✅ Tes A14-15.
- [Ringan] Data biaya, harga, dan 4 karakter terakhir key terlihat oleh Editor/Reviewer lewat `GET /api/ai/providers`. ✅ Sekarang non-owner hanya menerima mode Copilot.
- [Ringan] Estimasi biaya rencana Copilot masih terlihat oleh Editor/Reviewer. ❓
- [Ringan] Error lama tidak hilang setelah aksi berikutnya berhasil. ✅

### Tim dan login
- [Ringan] Log start menulis "1 email diizinkan" padahal tim berisi 3 orang. ✅
  - Log ditulis saat start, dan anggota ditambah sesudahnya. Teks sekarang menjelaskan itu.
- [Ringan] HP: email panjang dan tombol Hapus di tabel Tim terpotong. ✅ Hanya CSS, belum teruji: butuh login Google.

### Server (umum)
- [Sedang] Proses mesin tidak ikut berhenti saat server berhenti. ✅
  - Sebelumnya, setelah restart, job lama bisa tetap jalan berdampingan dengan job baru.
  - Sekarang `stopAll`, ditambah sapu job yatim saat start. Tes `audit-engine.test.ts`.
- [Sedang] Siapa pun bisa memicu FFmpeg tanpa batas lewat `GET /api/media/:id/visuals`. ✅
  - Sekarang maksimal 2 sekaligus. Lokasi `apps/server/src/cuts.ts`. Tes `audit-backend.test.ts`.
  - Timeout per FFmpeg ⏳ menunggu commit visuals.
- [Ringan] Path Linux tidak disamarkan di pesan mesin, dan alamat `https://` malah ikut tersensor. ✅
- [Sedang, khusus VPS Linux] Pembatalan job mesin hanya menghentikan Python induk, sehingga job bisa menggantung. ⏳
  - Lokasi: `packages/core/src/storage/engine.ts` (killTree).
  - Tidak bisa diuji di Windows. Perlu dikerjakan sebelum jalur B dipakai.

---

## 3. Yang diperiksa dan lulus tanpa temuan

- **Tabel peran:** setiap route jatuh ke aturan yang benar.
  - Halaman Tim, pemakaian AI, Brand, AI, dan purge hanya untuk Owner.
  - Persetujuan untuk Owner/Reviewer.
  - Reviewer tidak bisa render, menjalankan mesin, atau upload.
- **Sesi login:**
  - Disimpan sebagai hash di disk, logout dan pencabutan langsung tertulis, batas 7/30 hari dicek setiap request.
  - Email yang dihapus dari Halaman Tim tetap tidak berlaku setelah restart.
- **Halaman Tim:** owner terakhir dilindungi, akun dari `.env.local` terkunci, akun sendiri tidak bisa diubah.
- **Hapus permanen:** token sekali pakai, frase konfirmasi, batas 10 menit, cek dependensi dan hash di dalam lock. Auto Trash dengan perlindungan 30 hari.
- **Input:** batas ukuran JSON, field aktor ditolak, upload dengan Content-Length persis, nama file disaring, file statis aman dari traversal, link stream/output ditandatangani.
- **Mesin:** dijalankan tanpa shell, argumen hanya dari ID yang sudah divalidasi, env dibatasi, thumbnail dan aset dibatasi ke foldernya. Status ditolak (kode 2) ditangani.
- **Render:** lease, verifikasi snapshot, tmp dibersihkan, batal menang sampai commit. Nama output tidak menimpa file lama.
- **Situs online:**
  - Login Google dengan sesi tersimpan.
  - Form Generate lengkap.
  - Batch Remix menyusun 3 varian sekitar 1 menit, dengan rincian, Setujui, dan Coret.
  - Editor dengan thumbnail dan waveform.
  - Import Media.
  - Brand A–E plus 100 SFX berlisensi CC0.
  - Trash, Storage, AI, dan Tim terbaca.
  - Di 375 px tidak ada overflow halaman selain yang sudah diperbaiki, dan tidak ada error console baru.

---

## 4. Commit lokal (belum di-push)

Aplikasi Motion Studio (repo ini), di atas `b9f9451`:

| Commit | Isi |
| --- | --- |
| `4f37a0c` | backend: varian belum disetujui tidak bisa dirender, mesin berhenti bersama server, batas FFmpeg visuals, failover AI, timeout upload, sapu job yatim, sensor path |
| `7f46548` | render: subtitle berkotak tetap tembus pandang selebar baris, Pop pada teks biasa |
| `ab2b4aa` | web ronde 1: pratinjau caption, inspector per klip, dialog tidak mencuri fokus, progres mesin tahan putus |
| `ee0646a` | ronde 2: antrean upload tetap, gaya tersimpan saat klip dilepas, alasan blokir dan Storage terbaca |
| `8033218` | ronde 3 (temuan uji online): form Batch bertahan, Shot berbahasa Indonesia, filter jenis Media, HP |
| `94c31a1` | ronde 4: editan Brand tidak hilang diam-diam, Editor tahan pindah cepat dan seek saat diputar |
| (laporan ini) | `docs/AUDIT-MENYELURUH-2026-11-14.md` |

Mesin (repo remotion, folder `pipeline/batch/` + `pipeline/pisah.py`): `58b1fe4`, `dea7d6d`, `4e1073b`, `aba89de`.
- Subtree `engine/` di repo ini **perlu disinkronkan** ke `aba89de`. Venus melakukannya saat push.

Tidak ikut commit, semuanya milik pihak lain dan menunggu izin owner:
- perbaikan visuals/paket1 (ucok);
- `deploy/windows/*.ps1` (venus);
- `PROGRESS.md`;
- bukti screenshot `audit/*/evidence`.

Diff semua commit sudah dipindai: tidak ada path lokal, email, atau rahasia.

---

## 5. Butuh keputusan owner

Rekomendasi Jenius ditulis setelah tanda →.

**Data dan isi**
1. **Isi Brand Kit Aysilla di Motion Studio** dari data lengkap yang sudah ada di repo mesin (`brandkit/aysilla.json`): font, warna, handle, CTA, warna dilarang, kamus, klaim.
   → Impor. Ini sekaligus memperbaiki salah transkrip di caption dan membuat brand guard bekerja.
2. **Musik berlisensi untuk Asset Library.** Tanpa ini Batch Remix tidak pernah memakai musik.
3. **Kalimat VO yang menyebut brand lain: dibuang atau cukup ditandai?**
   → Dibuang (sekarang begitu), karena ini soal keamanan brand.
4. **Bangun ulang Shot Library batch video winning** (sekitar 1 jam) supaya label teks latar berlaku.
5. **Shot Library multi-brand:** transkrip Shot Library selalu memakai brand kit Aysilla (`pipeline/batch/shotlib.py:357`). Job pisah perlu membawa brand-nya.
6. Durasi varian Konversi bisa sampai 63 detik. Keputusan sebelumnya: durasi tanpa batas. Perlu batas atau cukup peringatan?

**Perilaku aplikasi**
7. B-roll menggantikan suara pembicara (pratinjau dan render). Suara utama tetap jalan atau tidak?
8. Penutup brand (outro), logo terang, dan logo "Hanya penutup" belum dipakai render Editor, hanya oleh mesin. Perlu ditambahkan?
9. Kode teknis di pesan error ("(CONFLICT)", "HTTP 502"): dibuang atau tetap?
10. Backspace menghapus klip terpilih: memang disengaja?
11. Klip yang tumpang tindih ditolak, bukan digeser: memang disengaja?
12. Job Generate yang sudah diterapkan bisa diterapkan lagi: perlu dikunci?
13. Kalau anggaran provider pertama habis: coba provider yang lebih murah?
14. Menghapus brand bawaan diam-diam memindahkan proyek tanpa brand ke brand lain.
15. Upload di Brand yang tidak disimpan menumpuk sebagai media tak terpakai.
16. Upload satu per satu (BUSY) atau diantrekan?
17. Estimasi biaya Copilot: perlu terlihat oleh Editor/Reviewer?
18. Default "Simpan ke" di Media: proyek yang sedang terbuka (sekarang) atau Media bersama?

**Infrastruktur**
19. **Pratinjau online lambat**, karena file asli dikirim penuh lewat terowongan dari PC kantor.
    → Proxy pratinjau resolusi rendah (pekerjaan baru), atau cek bandwidth upload kantor.
20. **Backup 0/104.**
    → Tentukan lokasi backup (disk kedua / NAS / cloud) secepatnya. Saat ini media hanya ada satu salinan.
21. **Perbaikan visuals (paket1, thumbnail FFmpeg 9) belum di-commit tapi sudah aktif di server online.** Commit kalau disetujui, atau kembalikan.
22. **Push semua commit lokal** (aplikasi dan mesin) beserta sync subtree `engine/`.

---

## 6. Rekomendasi operasional (ditangani venus)

- ✅ Log penjaga server dan terowongan sudah diperbaiki (belum di-commit, `deploy/windows`).
- ❓ **Watchdog:** task terjadwal tiap 5 menit yang menyalakan server kalau port server kosong. Ini menjaga situs dari kejadian seperti 18.41.
- ❓ **Aktifkan log Task Scheduler (Operational)** di PC kantor, supaya penghentian task bisa dilacak. Ini setelan sistem.
- Aturan tim yang sudah disebarkan:
  - tes tidak boleh memakai port server online atau mematikan proses node/powershell secara umum;
  - restart server hanya lewat Stop/Start task, setelah cek tidak ada job yang jalan, dan kabari venus.
- Sebelum VPS jalur B dipakai: kerjakan killTree untuk Linux (bagian 2, Server).
