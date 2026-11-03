# IMPLEMENTATION PLAN v2.0 — web app + Google Drive
Status: **MENUNGGU PERSETUJUAN URUTAN OWNER** (PRD: urutan backlog wajib disetujui). Dasar: ADR-002. v1.0 (T01–T15 storage core) selesai dan dipakai ulang.

Aturan tetap: satu task aktif; tiap task diuji; checkpoint audit (reviewer independen) tiap 5 task; tidak ada push/deploy tanpa izin owner.

## Fase 1 — Fondasi web + Drive
- [ ] W01 Restrukturisasi repo: `packages/core` (storage yang ada), `apps/server`, `apps/web`; skrip dev; semua tes lama tetap lulus.
- [ ] W02 Antarmuka `StorageBackend` di core; backend `LocalFs` = perilaku sekarang (133 tes lulus tanpa diubah maknanya).
- [ ] W03 Server API dasar (Node/TS): health, sesi, error bertipe, aktor ditegakkan di server.
- [ ] W04 Login Google (OAuth) + allowlist email + penyimpanan token terenkripsi. *Uji nyata butuh OAuth Client ID dari owner (langkah manual, dipandu).*
- [ ] W05 Backend `GoogleDrive`: layout folder, upload/download stream, pindah ke `.trash` app, hapus permanen manual, checksum Drive. Diuji dengan Drive tiruan + uji nyata dengan akun owner.
**CHECKPOINT D**

## Fase 2 — Editor yang bisa dipakai
- [ ] W06 Endpoint proyek & media: buat proyek, import via Google Picker, daftar media, dashboard storage.
- [ ] W07 UI web dari prototype (React): proyek, media library, layout editor, Trash/purge/restore, dashboard.
- [ ] W08 Editor timeline inti: pilih, geser, trim, split, undo/redo di atas skema proyek.
- [ ] W09 Preview: proxy/cache lokal, playhead sinkron teks/video/audio, rasio & safe area.
- [ ] W10 Render MP4 nyata (FFmpeg lokal): preflight + lease (T15), status job, upload hasil ke Drive.
**CHECKPOINT E**

## Fase 3 — Copilot & AI
- [ ] W11 Copilot planner lokal → edit plan JSON tervalidasi → diff → setujui → terapkan → undo.
- [ ] W12 AI Provider Manager (API key manual, rahasia di server) + router & failover resmi.
- [ ] W13 Usage/biaya, batas anggaran keras, audit.
- [ ] W14 Caption/STT + edit transkrip.
- [ ] W15 Uji E2E UI (Playwright) + paket deploy VPS (deploy nyata menunggu izin owner).
**CHECKPOINT F**

## Ditunda (keputusan owner)
- Sewa VPS & deploy online: setelah Fase 2 (UI/UX + frontend + backend) jadi.
