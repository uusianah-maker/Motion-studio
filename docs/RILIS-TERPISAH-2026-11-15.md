# Rilis terpisah untuk situs live (sukma, 15 Nov 2026)

Tugas dari venus. Owner sudah mengizinkan restart "saat siap". **Pergantian ke rilis belum dijalankan.** Rilis pertama dipicu venus setelah tugas ucok berikutnya lulus audit.

## Masalah
Server live (`apps\server\dist\main.js`, mulai 18.00) melayani tampilan dari `apps\web\dist` di folder kerja yang sama dengan tim.
- Setiap `npm run build` saat tes langsung mengganti tampilan motionproject.online. Owner melihat menu R17 pukul 19.42.
- Saat itu backend masih kode pukul 18.00, jadi UI setengah jadi tampil ke tim dan route baru bisa error.

## Rancangan
```
D:\VIBECODING\Motion Studio Release\
  AKTIF.txt         nama rilis yang dijalankan server live
  SEBELUMNYA.txt    rilis sebelumnya (tujuan -Kembali)
  rilis\<yyyyMMdd-HHmmss>_<sha7>\   salinan bersih 1 commit + hasil build (+- 28 MB, tanpa node_modules)
       RILIS.json   commit, judul, waktu, hasil smoke
  log\              log rilis + output npm/build/smoke per rilis (dihapus setelah 30 hari)
```
- **Isi rilis:** `git archive <commit>`, jadi tanpa WIP, tanpa file yang belum di-commit, dan tanpa `.env.local`. Lalu `npm ci` dan `npm run build` di folder rilis itu, dengan prioritas Idle. Saat jalan, server tidak butuh `node_modules` (hanya modul bawaan Node), jadi foldernya dihapus setelah build.
- **`start-motion.ps1`:** setiap kali server mulai, skrip membaca `AKTIF.txt` lalu menjalankan `main.js` dari rilis itu. `MOTION_ENV_FILE` menunjuk ke `.env.local` di folder kerja. Workspace, state dir (`~\.motion-studio`), port 4317, dan mesin (`MOTION_ENGINE_ROOT`) tidak berubah.
  - Kalau belum ada rilis, atau rilisnya tidak lengkap, server jalan dari folder kerja seperti dulu dan hal itu dicatat di log penjaga. Jadi perubahan skrip ini aman walaupun task terlanjur di-restart sebelum rilis pertama.
- **Pergantian = tulis `AKTIF.txt` lalu mulai ulang server.** exFAT tidak mendukung junction atau symlink, karena itu dipakai file penunjuk.

## `deploy\windows\rilis.ps1`
| Perintah | Hasil |
|---|---|
| `-Status` | Rilis aktif, rilis sebelumnya, daftar rilis, dan proses yang sedang memegang port 4317 |
| `-Commit <sha> -TanpaGanti` | Menyiapkan rilis: salin, `npm ci`, build, smoke. Situs tidak berubah |
| `-Aktifkan <nama>` | Memasang rilis yang sudah disiapkan |
| `-Commit <sha>` | Menyiapkan lalu langsung memasang |
| `-Kembali` | Kembali ke rilis di `SEBELUMNYA.txt` |

Pengaman:
1. Commit harus ada di `main`. `-BukanMain` hanya untuk uji.
2. Commit harus berisi Motion Studio. Riwayat `main` juga memuat commit mesin dari git subtree, yang isinya repo remotion; commit seperti itu ditolak sebelum `npm ci`.
3. Smoke dijalankan di port uji 4398 dengan workspace dan state dir **sementara**, tanpa variabel `MOTION_*` dan tanpa `.env.local`. Workspace live sengaja tidak dipakai, karena server kedua di sana akan ikut recovery/GC dan menutup job yang sedang berjalan. Yang dicek:
   - `/api/health`;
   - `/` sama persis dengan `index.html` rilis;
   - semua `/assets/*` berstatus 200;
   - `/api/session`, `/api/projects`, dan `/api/engine` dengan token;
   - permintaan tanpa token ditolak.
4. **Cek sibuk sebelum restart.** Restart ditolak (kode 3) kalau masih ada pekerjaan:
   - lease di `.motionstudio\leases.json` (render atau job mesin);
   - `06_ENGINE\*\status.json` berstatus `berjalan` yang diubah dalam 30 menit terakhir;
   - status `menunggu` yang diubah dalam 2 jam terakhir.
   `-Paksa` melewati cek ini.
5. **Restart memakai Stop/Start task `MotionStudio-Server`**, sesuai aturan tim. Kalau node lama masih memegang port 4317 setelah 20 detik, hanya pid itu yang dihentikan, dan hanya kalau command line-nya `apps\server\dist\main.js`.
6. **Sehat** berarti `/api/health` ok **dan** proses di port 4317 jalan dari folder rilis yang baru. Kalau tidak tercapai dalam 2 menit, `AKTIF.txt` dikembalikan ke rilis lama, server di-restart lagi, dan skrip keluar dengan kode 4.
7. Hanya satu rilis bisa berjalan pada satu waktu (`.rilis.lock`). Tiga rilis terbaru disimpan (`-Simpan`); rilis aktif dan sebelumnya tidak pernah dihapus.

Kode keluar: 0 ok · 1 salah pakai / commit ditolak · 2 gagal menyiapkan (situs tidak berubah) · 3 server sibuk · 4 rilis gagal lalu di-rollback.

## Hasil uji (tanpa menyentuh situs live)
Uji memakai folder rilis uji `D:\VIBECODING\Motion Studio Release Uji` (exFAT, sama dengan aslinya). Penjaga uji adalah `start-motion.ps1` asli yang dijalankan dengan `-Rilis` folder uji, `-EnvFile` berisi workspace dan state sementara, port 4397, dan log sementara. Restart memakai `-CaraRestart Proses`: node di port uji dihentikan, lalu penjaga uji menyalakannya lagi.

| # | Uji | Hasil |
|---|---|---|
| 1 | Penjaga tanpa rilis | Jalan dari folder kerja, tercatat "folder kerja (belum ada rilis)" |
| 2 | `-Commit main -TanpaGanti` | Selesai dalam 155 dtk: salin 23, `npm ci` 99, build 20, smoke 4 dtk. Smoke lulus, folder 27,7 MB |
| 3 | `-Aktifkan` | Server sehat dari rilis dalam **15 dtk** (jeda penjaga 10 dtk), proses jalan dari folder rilis |
| 4 | Rilis rusak (`main.js` langsung keluar) | Setelah 2 menit kembali otomatis ke rilis lama, sehat 19 dtk kemudian, kode 4 |
| 5 | Lease render palsu | Ditolak, kode 3, situs tidak di-restart |
| 6 | `status.json` job mesin berjalan | Ditolak, kode 3 |
| 7 | Commit mesin (subtree remotion, `0d18b2a`) | Ditolak dalam 2 dtk, sebelum `npm ci` |
| 8 | Ref tidak ada · `-PortUji 4317` · `-Kembali` tanpa rilis sebelumnya | Semua ditolak |
| 9 | `-Commit main` penuh (347b617): siapkan, pasang, lalu `-Kembali` | Siap dalam 155 dtk, aktif dalam **13 dtk**. `-Kembali` ke ab861e5 sehat dalam **14 dtk**. `-Simpan 1` menghapus rilis lama, sementara rilis aktif dan sebelumnya tetap ada |

Selama semua uji, server live tetap pid 17800 (mulai 18.00, folder kerja) dan `https://motionproject.online/api/health` ok. Folder uji, penjaga uji, dan workspace uji sudah dihapus. Folder rilis asli (`D:\VIBECODING\Motion Studio Release`) belum dibuat; ia dibuat otomatis saat rilis pertama.

Ditemukan dan diperbaiki saat uji:
- Peringatan git di stderr dianggap error fatal oleh PowerShell 5.1.
- Log ikut masuk ke nilai kembali fungsi.
- `-e` milik `git cat-file` terikat ke parameter fungsi `Luar`.
- Setelah rollback, `SEBELUMNYA.txt` menunjuk ke rilis yang gagal.
- Folder staging yang gagal tidak terhapus (sekarang ada cadangan `rmdir`).

Belum diuji: restart lewat task (`-CaraRestart Task`, bawaan) di situs live. Itu Stop/Start task yang sama dengan restart manual sebelumnya; pertama kali dipakai saat rilis pertama oleh venus.

## Catatan untuk rilis pertama (venus)
1. Pakai cara bawaan (Task), **jangan** `-CaraRestart Proses`. Penjaga live yang sekarang jalan masih memuat kode lama yang tidak membaca `AKTIF.txt`; Stop/Start task memuat `start-motion.ps1` yang baru.
   - Kalau `Proses` terlanjur dipakai, server lama kembali dari folder kerja, cek "sehat dari rilis" gagal, dan skrip rollback sendiri. Situs tetap hidup, tapi ada jeda sekitar 2 menit.
2. Langkahnya:
   ```
   deploy\windows\rilis.ps1 -Commit <sha> -TanpaGanti
   deploy\windows\rilis.ps1 -Aktifkan <nama>
   deploy\windows\rilis.ps1 -Status
   ```
   Persiapan bisa kapan saja; pemasangan dilakukan saat sepi.
3. Setelah aktif, build di folder kerja tidak lagi mengubah situs. Perubahan baru tampil hanya setelah rilis berikutnya.

## Sisa risiko (di luar tugas ini)
- **Mesin masih jalan dari folder kerja.** `MOTION_ENGINE_ROOT=D:\VIBECODING\remotion` adalah repo kerja venus/yuki, jadi perubahan `pipeline\engine.py` yang belum diaudit langsung dipakai job dari situs. Pola rilis yang sama bisa dipakai untuk mesin, tapi itu tugas terpisah.
- **Skrip penjaga dibaca dari folder kerja.** Task menunjuk ke `deploy\windows\*.ps1` di repo kerja, jadi perubahan WIP di skrip itu berlaku pada restart task berikutnya. File-file itu jarang diubah dan hanya oleh sukma.
- **Upload yang sedang berjalan tidak terdeteksi oleh cek sibuk.** Upload itu akan terputus dan harus diulang. Pasang rilis saat sepi.
