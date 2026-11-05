# IMPLEMENTATION PLAN v2.0 — web app + Google Drive (urutan B: UI dulu, Drive menyusul)
Status: **DISETUJUI OWNER 2026-11-04 (PC-8: B)** — "Gas jalankan Point B". Dasar: ADR-002. v1.0 (T01–T15 storage core) selesai dan dipakai ulang.

Aturan tetap: satu task aktif; tiap task diuji; checkpoint audit (reviewer independen) tiap 5 task; tidak ada push/deploy tanpa izin owner.

Alasan urutan B: owner bisa mencoba app dan memberi masukan UI/UX secepatnya; setup Google Cloud (manual oleh owner) tidak memblokir. Risiko integrasi Drive ditekan oleh antarmuka `StorageBackend` (W02) — UI dan server tidak tahu file ada di disk atau di Drive.

## Fase 1 — Fondasi lokal + UI (tanpa Google)
- [x] W01 Restrukturisasi repo: `packages/core` (storage yang ada); `apps/server` (W03) dan `apps/web` (W05) dibuat oleh task-nya; skrip root (`verify`, `test:e2e`, `test:prototype`) tetap jalan; 133 pass / 1 skip, E2E 18/18, prototype 56/56. *Bukan npm workspaces: D: exFAT tidak bisa symlink → satu paket + TS project references.*
- [x] W02 Antarmuka `StorageBackend` di core; backend `LocalFs` = perilaku sekarang (semua tes lama lulus tanpa diubah maknanya). Metadata tetap lokal; byte media/Trash/output lewat backend. Tes kontrak `backendContract()` dipakai ulang untuk backend Drive di W10.
- [x] W03 Server API dasar (Node/TS): hanya listen di 127.0.0.1, health, sesi lokal (token acak per start, belum Google), error bertipe, aktor ditegakkan di server (browser tidak bisa mengaku "user" untuk aksi AI/scheduler).
- [x] W04 Endpoint proyek & media (backend lokal): buat/buka proyek, import file (upload dari browser), daftar media, Trash/restore/purge manual (token + frasa), dashboard storage.
- [x] W05 UI web dari prototype (React): daftar proyek, media library, layout editor, Trash/purge/restore, dashboard storage.
**CHECKPOINT D**

## Fase 2 — Editor + sambung Google Drive
- [ ] W06 Editor timeline inti: pilih, geser, trim, split, undo/redo di atas skema proyek.
- [ ] W07 Preview: proxy/cache lokal, playhead sinkron teks/video/audio, rasio & safe area.
- [ ] W08 Render MP4 nyata (FFmpeg lokal): preflight + lease (T15), status job, output versioned di 05_OUTPUT.
- [ ] W09 Login Google (OAuth "External", scope `openid email profile drive.file`) + allowlist email + token terenkripsi di server. *Uji nyata butuh OAuth Client ID dari owner (langkah manual, dipandu).*
- [ ] W10 Backend `GoogleDrive`: owner memilih folder workspace via Google Picker sekali; layout folder, upload/download stream, `.trash` milik app, purge manual, checksum Drive; import via Picker; hasil render di-upload ke Drive. Diuji dengan Drive tiruan + uji nyata ke folder owner.
**CHECKPOINT E**

## Fase 3 — Copilot & AI
- [ ] W11 Copilot planner lokal → edit plan JSON tervalidasi → diff → setujui → terapkan → undo.
- [ ] W12 AI Provider Manager (API key manual, rahasia di server) + router & failover resmi.
- [ ] W13 Usage/biaya, batas anggaran keras, audit.
- [ ] W14 Caption/STT + edit transkrip.
- [ ] W15 Uji E2E UI (Playwright) + paket deploy VPS (deploy nyata menunggu izin owner).
**CHECKPOINT F**

## Catatan Drive owner
- Folder workspace yang disiapkan owner: "video motion folder" (`1pls4-EtmxPa09oxctKgaTx352OOMqWnF`, My Drive, kosong per 2026-11-04).
- Dengan `drive.file`, app hanya bisa memakai folder ini setelah owner memilihnya lewat Picker (W10); perilaku listing isi folder yang dipilih wajib diverifikasi di W10.

## Ditunda (keputusan owner)
- Sewa VPS & deploy online: setelah Fase 2 (UI/UX + frontend + backend) jadi.
