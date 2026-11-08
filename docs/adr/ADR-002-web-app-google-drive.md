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

## Keputusan lanjutan (2026-11-04)
- **PC-6 = B:** Gmail pribadi (kuota 2 TB). Workspace = folder di My Drive; OAuth "External", di-set "In production" (bukan testing) supaya refresh token tidak kedaluwarsa 7 hari.
- **PC-7 = A:** scope `drive.file` (+ `openid email profile`), non-sensitive. App hanya melihat file buatannya atau yang dipilih via Google Picker; import = Picker atau upload dari app.

- **PC-8 = B:** UI web + editor dulu di atas backend lokal; Login Google + Drive di W09–W10.

## Perubahan 2026-11-09 — PC-13: tanpa Google Drive
- Owner: "filenya kita fokus di file lokal aja jadi apps ini hanya bisa online aja, tapi semua file tetap lokal".
- **Penyimpanan:** backend `LocalFs` (disk mesin yang menjalankan server) menjadi penyimpanan final. W10 (backend GoogleDrive) dibatalkan. Bagian ADR ini tentang Drive (checksum Drive, `.trash` di Drive, Picker) tidak berlaku.
- **Akses online:** app tetap web; login Google + allowlist (W09) menjaga akses. Scope dikurangi menjadi `openid email profile`; tidak ada token Google yang disimpan.
- **Konsekuensi deploy (W15):** "lokal" = disk mesin server. Opsi: (a) server tetap di PC owner (D: SSD) dan dibuka online lewat tunnel/reverse proxy → file benar-benar di PC owner; (b) VPS → file di disk VPS. Dipilih di W15.
