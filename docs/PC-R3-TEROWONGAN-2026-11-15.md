# PC-R3 Perbaikan macet terowongan (sukma, 15 Nov 2026)

Tugas dari venus, disetujui owner ("gas perbaiki"). VPS tidak di-restart, konfigurasi VPS (Caddy, sshd, authorized_keys) tidak diubah, dan Affiliate OS tidak disentuh. Selama perbaikan situs tidak pernah putus.

## Gejala
Unduhan lewat motionproject.online sesekali macet 12–30 dtk (1 dari 6–20 permintaan). Pada 15 Nov sekitar pukul 17.30 kondisinya jauh lebih parah: **setiap** permintaan butuh 17–25 dtk, termasuk `/api/session` yang hanya beberapa byte. Langsung ke server di PC (`127.0.0.1:4317`) selalu 0,06–0,2 dtk.

## Penyebab (dengan bukti)
1. **Jeda ada di dalam terowongan, bukan di Caddy atau internet pengguna.** Dari VPS langsung ke ujung terowongan (`curl http://127.0.0.1:14317/api/session`), koneksi tersambung dalam 0,0002 dtk tetapi jawabannya baru datang **14–17 dtk** kemudian (5 dari 5 kali).
2. **Yang lambat adalah ssh.exe di PC, bukan jaringannya.** Status TCP terowongan di VPS dicatat tiap detik selama satu permintaan:
   - VPS meneruskan permintaan seketika;
   - PC baru membalas "saluran dibuka" setelah ± 4,5 dtk;
   - jawaban HTTP datang ± 10 dtk sesudahnya;
   - di antaranya koneksi TCP diam (tidak ada data tertunda dan tidak ada pengiriman ulang). Artinya jaringan siap, tapi PC belum mengirim.
3. **Proses ssh.exe dan server berjalan di prioritas `BelowNormal`** (task `MotionStudio-Tunnel` dan `MotionStudio-Server` memakai priority 7). Saat diukur, **CPU PC 100%**: ada analisa batch dari sesi lain (OCR + Whisper, 3 pekerja, sejak 16.17) yang memakai ± 11 dari 16 core di prioritas Normal. Proses BelowNormal hanya kebagian sisa CPU, jadi tiap langkah kecil ssh.exe dan node harus antre beberapa detik.
4. Macet sesekali di hari sebelumnya cocok dengan pola yang sama: render, Whisper, dan tes berat di PC yang sama.

Faktor sampingan yang **bukan** penyebab macet ini, tapi menambah lambat:
- PC tersambung lewat **Wi-Fi** (MediaTek MT7921), bukan kabel.
- Ping ke VPS hilang 1% dengan lonjakan sampai 148 ms.
- TCP terowongan mencatat ± 9,5% data VPS→PC dikirim ulang dan banyak paket tidak berurutan.

## Perbaikan (kecil, hanya di PC, bisa dibalik)
| File | Perubahan |
|---|---|
| `deploy/windows/start-tunnel.ps1` | Setelah ssh.exe dijalankan: `PriorityClass = AboveNormal`. ssh.exe hampir tidak memakai CPU (± 14 dtk CPU dalam 6 jam), jadi aman |
| `deploy/windows/start-motion.ps1` | Setelah node dijalankan: `PriorityClass = Normal`. Proses mesin anak ikut Normal, sehingga CPU dibagi adil dengan pekerjaan lain |
| `deploy/windows/watchdog.ps1` | Tiap 5 menit memastikan terowongan AboveNormal dan server Normal; hanya mencatat kalau mengubah. Ini jaring pengaman kalau penjaga lama masih berjalan dengan kode lama |

Tidak dipilih: 2 terowongan paralel, ubah Caddy, atau WireGuard/Tailscale. Penyebabnya CPU di PC, jadi perbaikan jaringan tidak akan menghilangkan macet ini, dan semuanya perlu mengubah VPS.

## Hasil ukur (metode sama: dari PC lewat https://motionproject.online)
Per uji: 50 permintaan kecil `/api/session` bersamaan dengan 25 unduhan 1,7 MB, lalu 40 permintaan potongan 256 KB yang meniru pemutar video. Web statis tidak mendukung Range, jadi kodenya 200; yang diukur adalah jeda per permintaan.

| Kondisi | Kecil median / maks | Besar median / maks | Potongan median / maks | Macet |
|---|---|---|---|---|
| Sebelum, CPU 100% (analisa batch) | 17–25 dtk tiap permintaan | macet sampai batas 25 dtk | – | hampir semua |
| Sesudah, langsung VPS → terowongan (CPU 87%) | 0,06 / 0,42 dtk (10×) | – | – | 0 |
| Sesudah, CPU normal (49%) | 0,16 / 0,59 | 0,48 / 0,86 | 0,39 / 0,66 | **0** |
| Sesudah, CPU 100% (beban buatan 16 core, prioritas Normal) | 0,20 / 0,52 | 0,41 / 1,20 | 0,49 / 1,11 | **0** |

Uji watchdog:
- Prioritas terowongan sengaja diturunkan ke BelowNormal, lalu watchdog dijalankan. Hasilnya kembali ke AboveNormal dan tercatat `prioritas terowongan (pid 20900) BelowNormal -> AboveNormal`.
- Setelah penjaga menyalakan ulang pukul 18.00, ssh (pid 17440) langsung AboveNormal dan node (pid 17800) langsung Normal dari skrip penjaga. Watchdog terjadwal pukul 18.36 tidak perlu mengubah apa pun.

Belum diuji: streaming media sungguhan (`/api/stream`, butuh sesi login owner). Yang diukur di atas adalah jeda per permintaan lewat terowongan, yaitu bagian yang sebelumnya macet. File 4K ± 21 Mbps tetap butuh pratinjau kecil (R14, ucok) supaya lancar dari luar kantor.

## Rollback
Tidak ada yang perlu dikembalikan di VPS. Di PC:
1. Kembalikan tiga file: `git checkout <commit sebelum PC-R3> -- deploy/windows/start-tunnel.ps1 deploy/windows/start-motion.ps1 deploy/windows/watchdog.ps1`, atau `git revert <commit PC-R3>`.
2. Supaya proses yang sedang berjalan ikut kembali tanpa restart:
   ```
   Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | ? CommandLine -match 'motiontunnel@' | % { (Get-Process -Id $_.ProcessId).PriorityClass = 'BelowNormal' }
   (Get-Process -Id (Get-NetTCPConnection -LocalPort 4317 -State Listen | Select -First 1).OwningProcess).PriorityClass = 'BelowNormal'
   ```
3. Tidak perlu restart server, terowongan, maupun VPS.

## Saran lanjutan (keputusan owner/venus, bukan bagian perbaikan ini)
1. **Kerja berat di PC server dijalankan di prioritas rendah**, misalnya analisa batch, Whisper massal, dan tes besar. Contoh: `start /BELOWNORMAL` atau `Start-Process ... ; $p.PriorityClass='BelowNormal'`, atau dengan membatasi jumlah pekerja. Dengan begitu tim online tidak ikut melambat.
2. **Pasang kabel LAN ke PC server** (bukan Wi-Fi). Ini mengurangi paket hilang dan tidak berurutan di terowongan.
3. Kalau macet masih muncul saat CPU tidak penuh, baru pertimbangkan perubahan di VPS (keepalive atau 2 terowongan + health check di blok Caddy Motion Studio). Itu perlu persetujuan terpisah.
