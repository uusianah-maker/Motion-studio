# Cara melanjutkan (untuk sesi Claude berikutnya)

Baca berurutan:
1. `PROGRESS.md` — status 15/15 task storage, audit checkpoint A/B/C, semua Pending Confirmation (PC-1..PC-5).
2. **PC-5 sudah diputuskan (A):** pivot ke **web app + Login Google + Google Drive**, 1 pengguna, VPS ditunda sampai UI/backend/frontend jadi. Baca `docs/adr/ADR-002-web-app-google-drive.md` dan `docs/IMPLEMENTATION_PLAN_v2.0.md`.
   Sudah dijawab: **PC-6 = B** (Gmail pribadi 2 TB → My Drive, OAuth External "In production"), **PC-7 = A** (`drive.file`, import via Google Picker).
   **PC-8 = B** (2026-11-04): UI dulu di lokal, Drive menyusul (W09–W10). Kerjakan berurutan dari `docs/IMPLEMENTATION_PLAN_v2.0.md`, lihat "Log task v2.0" di PROGRESS.
   Masih ditunggu: **PC-9** (owner matikan link share publik folder Drive) — tidak memblokir W01–W09.
3. `docs/PRD_MASTER_v1.0.md` (source of truth) dan `docs/adr/ADR-001-*`.

Gaya kerja owner: Bahasa Indonesia santai & simpel; jalan otomatis pakai `/gasngoding`; audit mandiri (subagent reviewer); keputusan dikumpulkan dan ditanyakan di akhir (~90%), pilihan ganda + rekomendasi.

Status v2.0: W01–W09 + W11 selesai (Checkpoint D lulus; W10 Drive dibatalkan PC-13, file tetap lokal); Checkpoint E lulus; W12 AI Provider Manager, W13 anggaran, W14 caption/STT selesai; berikutnya W15 (uji E2E UI + paket deploy) lalu Checkpoint F. Fitur AI/STT baru diuji dengan provider tiruan: uji nyata butuh owner memasukkan API key sendiri di menu AI. Render (W08) wajib menghapus metadata — lihat PROGRESS baris W08. Login Google (W09) aktif bila env Google diisi; uji nyata menunggu owner membuat OAuth Client (PC-12, `docs/SETUP_GOOGLE_LOGIN.md`).

Verifikasi: `npm ci` lalu `npm run verify` (core 201 pass / 1 skip, server 76/76, web 11/11, smoke), `npm run test:ui` (W05 20, W06 16, W07 19, W08 16, W09 14, W11 11, W12 13, W13 9, W14 11; butuh Chrome + FFmpeg ≥7), `npm run test:e2e` (18/18), `npm run test:prototype` (56/56).
Belum pernah push/deploy — wajib izin owner.
