# ADR-002 — Pivot: web app tim + Google Drive sebagai penyimpanan

- **Status:** Accepted oleh owner 2026-11-04 (PC-5: opsi A). Mengganti ADR-001 bagian shell/lokasi media; aturan storage (Smart GC, purge manual, AI tidak boleh menghapus) tetap berlaku.
- **Mengubah PRD §0.1:** keputusan 1 ("desktop/hybrid, local-first") dan 2 ("01_INPUT per project lokal") → web app; file asli & hasil render di Google Drive.

## Keputusan owner (2026-11-04)
1. Opsi A: web app + Login Google + Google Drive via API + server render.
2. Pengguna: 1 orang (tim kecil). Akses dibatasi **daftar email yang diizinkan** (bukan pendaftaran publik) — default aman; bisa dibuka nanti atas keputusan owner.
3. VPS ditunda sampai UI/UX + frontend + backend selesai. Selama pengembangan, server + render berjalan di komputer owner (localhost; D: SSD ±1,5 TB untuk cache).

## Arsitektur
```
Browser (React)  ──HTTPS/localhost──►  Server (Node/TS)
                                          ├─ Auth: Google OAuth + allowlist email, sesi server
                                          ├─ Storage core (sudah ada) + adapter backend:
                                          │     LocalFs (tes/dev)  |  GoogleDrive (produksi)
                                          ├─ Metadata (registry, dependency, journal, audit): disk server
                                          ├─ Render worker (FFmpeg) + cache lokal (proxy, temp)
                                          └─ Google Drive API ──► folder workspace di Drive
```

## Aturan penting
- **Byte video tetap diunduh sementara** ke mesin render (cache lokal); file asli dan output tinggal di Drive.
- **Trash bawaan Google Drive tidak dipakai** (otomatis hapus permanen 30 hari → bentrok "purge selalu manual"). App memakai folder `.trash` sendiri di Drive (pindah = ganti parent, atomik di Drive). Purge = hapus permanen via API **hanya** lewat dialog manual (token + frasa), seperti sekarang.
- **Integritas:** pakai checksum dari Drive (`sha256Checksum`, cadangan `md5Checksum`; diverifikasi tersedia di W05) — cek perubahan tanpa mengunduh. Perubahan isi tanpa versi baru → CHANGED (GC-11).
- **Secret** (OAuth client secret, refresh token) hanya di server, terenkripsi; tidak pernah di browser, project JSON, atau log.
- **Lock & metadata** dipegang server (satu proses); Drive tidak punya rename atomik/lock untuk JSON, jadi registry tidak disimpan sebagai sumber kebenaran di Drive (cadangan JSON boleh disalin ke Drive).

## Opsi yang ditolak
- Link share Drive sebagai mekanisme utama: halaman konfirmasi file besar, batas unduh, tidak bisa list/upload, risiko bocor. (Tetap boleh sebagai cara *memilih* file, lihat PC-7.)
- Google Drive for Desktop di tiap komputer: tidak cocok untuk tim/online.
- Object storage (R2/S3): lebih cepat/murah, tapi owner ingin file terlihat di Drive.

## Keputusan yang masih terbuka
- **PC-6:** akun Google owner — Google Workspace (bisa Shared Drive + "Internal app") atau Gmail pribadi (folder di My Drive).
- **PC-7:** izin Drive — `drive.file` (rekomendasi) vs `drive` penuh. Lihat `PROGRESS.md`.
