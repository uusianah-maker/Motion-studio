# R14 ukur jaringan + R15 backup (sukma, 15 Nov 2026)

Tugas dari venus. Tidak ada konfigurasi server/VPS yang diubah. Tidak ada jadwal yang dipasang.

## R14 Ukur kecepatan

### Internet PC kantor (langsung, tanpa terowongan)
| Arah | Hasil | Cara |
|---|---|---|
| Download | 8,9–10,7 MB/dtk (72–86 Mbps) | 100 MB ovh.net, 25 MB Cloudflare |
| Upload | 4,3–6,7 MB/dtk (35–54 Mbps) | 25 MB ke Cloudflare, 2× |

### Lewat motionproject.online (jalur tim dari luar: VPS → terowongan SSH → PC)
File 1,7 MB dari web Motion Studio, 20× dari PC kantor. Jadi data menempuh PC → VPS → PC; tim di luar hanya menempuh setengahnya.

| | Lewat situs | Langsung ke server di PC |
|---|---|---|
| Median | 0,73 dtk (± 2,3 MB/dtk, waktu tunggu awal 0,2–0,3 dtk) | 0,06 dtk |
| Terburuk | **macet sampai batas 20–30 dtk** (1 dari 20; di dua seri lain 1 dari 6 dan 1 dari 8) | 0,2 dtk, tidak pernah macet |

Kesimpulan:
1. **Server di PC tidak lambat. Hambatannya di terowongan SSH/VPS.** Sesekali ada permintaan yang macet belasan detik. Ini cocok dengan temuan audit S4: preview Editor sempat hanya ter-buffer 0,68 dtk dalam 14 dtk, dengan request stream berulang kali `ERR_ABORTED`.
2. **Preview memakai file asli.** Contoh `hl_000001.mp4` adalah **4K 2160×3840, 130 MB untuk 49 dtk (± 21 Mbps, butuh ± 2,6 MB/dtk terus-menerus)**. Itu setara atau di atas kemampuan satu aliran lewat terowongan (± 2,3 MB/dtk), belum termasuk macet sesekali dan internet editor sendiri. Jadi preview pasti tersendat.
3. **Upload hanya bisa satu per satu.** Server menolak upload kedua dengan "Upload lain sedang berjalan" (`/api/media/import`, flag `importing`). Kalau dua editor upload bersamaan, salah satunya ditolak. Ini bertentangan dengan "import tidak boleh lambat untuk tim".

Belum diukur (butuh owner login di browser pane): upload 1 video ± 100 MB dan buka preview nyata lewat situs. Rencananya: unduh 1 media lewat stream lalu unggah lagi. Server mengenali file yang sama, jadi tidak menambah isi workspace. Perkiraan dari angka di atas, untuk editor dengan upload rumahan 10–20 Mbps: 100 MB butuh ± 40–80 dtk. Penghambatnya internet editor, bukan PC kantor.

### Rekomendasi R14 (untuk diputuskan owner, dikerjakan ucok)
1. **Pratinjau resolusi kecil: PERLU.** Buat sekali per media saat import, misalnya **540×960 (9:16), H.264 ± 1,2 Mbps, keyframe tiap 1 dtk, AAC 96 kbps**. Kira-kira **0,15 MB/dtk**, 15× lebih ringan dari file 4K tadi, sehingga lancar di atas jalur ± 2 MB/dtk walau sedang macet sesaat. Render tetap memakai file asli. Tambahan disk ± 9 MB per menit video.
2. **Terowongan:** cari tahu kenapa ada macet 12–30 dtk. Bisa dari SSH satu koneksi (semua pengguna lewat satu TCP; satu paket hilang membuat semua menunggu) atau dari Caddy/VPS. Ide untuk dibahas, tidak diubah sekarang: tambah 2 terowongan paralel, atau WireGuard/Tailscale. VPS dan Affiliate OS tidak disentuh.
3. **Upload paralel:** izinkan 2–3 upload sekaligus, atau antrekan di server, bukan langsung ditolak.

## R15 Backup mingguan

Skrip + cara pulih: `deploy/backup/` (lihat README di sana). Sudah diuji: backup penuh 64 dtk, backup berikutnya 7 dtk, pulih 17 dtk, hash 178 media cocok, workspace hasil pulih terbaca 74/74 proyek.

### Temuan penting
**Workspace ada di `D:` = SanDisk Portable SSD lewat USB** (exFAT, cluster 1 MB). Kalau SSD tercabut, rusak, atau hilang, semua media asli, Brand Kit, dan proyek hilang. Saat ini **tidak ada backup sama sekali** (Storage: "Backup terverifikasi 0/178").

### Ukuran
| Bagian | Sekarang | Perkiraan tambahan per minggu* |
|---|---|---|
| Media asli (wajib) | 1,22 GB | 3–7 GB (hanya file baru yang disalin) |
| Snapshot data (wajib) | 17 MB | 17 MB, disimpan 8 minggu ≈ 140 MB |
| Render (opsional) | 0,61 GB | ± 1–1,5 GB |
| **Total** | **1,84 GB** | **± 4–9 GB per minggu**, jadi ± 200–450 GB per tahun karena media tidak pernah dihapus dari backup |

*Dasar: 13–15 Nov masuk 1,28 GB media dan 0,64 GB render, termasuk banyak uji. Dengan target 6 video/hari dan rekaman 50–150 MB per video, didapat 2–6 GB media per minggu.

### Pilihan lokasi (keputusan owner)
| Pilihan | Kelebihan | Kekurangan | Biaya |
|---|---|---|---|
| A. Disk internal PC (C:, NVMe) | Paling cepat (± 1 menit), langsung bisa | Sisa hanya 33 GB, cukup ± 1–2 bulan; ikut hilang kalau PC rusak | 0 |
| B. HDD/SSD eksternal kedua (bukan SanDisk yang sama) | Murah per GB, cepat, kapasitas besar | Harus selalu terpasang saat jadwal; satu lokasi fisik | HDD 2 TB ± Rp 1 jt sekali beli |
| C. Google Drive (Drive for desktop, folder `G:\My Drive\MotionBackup`) | Di luar kantor, aman dari rusak/hilang | 15 GB gratis cukup ± 2 minggu; perlu Google One 100 GB/2 TB; minggu pertama upload ± 2 GB (± 5–10 menit), lalu 4–9 GB/minggu (± 15–30 menit) | Google One 2 TB ± Rp 135rb/bln |
| **D. Saran: B + C sebagian** | Media + render ke disk eksternal kedua tiap minggu, plus snapshot data kecil (`-Simpan 8`, tanpa media) ke Google Drive. Kalau kantor kebakaran, Brand Kit, proyek, dan riwayat tetap ada di luar | Media asli hanya di satu backup lokal | HDD sekali beli |

Catatan: Motion Studio sudah punya pencatat backup terverifikasi (`packages/core/src/storage/backup.ts`, `registerBackupLocation` + `verifyBackupLocation`, cek hash read-only), tapi belum ada tombolnya di UI/API. Kalau lokasi sudah dipilih, ucok bisa menambah tombol "Verifikasi backup" di menu Storage supaya angka "Backup terverifikasi" terisi dan media yang sudah di-backup tercatat.
