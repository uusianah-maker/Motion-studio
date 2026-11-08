# Checkpoint D — audit W01–W05 (fondasi lokal + UI web)

Tanggal: 2026-11-08 · Cakupan: `git diff 7392131..e9b4d24` (W01 restrukturisasi, W02 StorageBackend, W03 server, W04 endpoint, W05 UI web)
Hasil: **LULUS setelah perbaikan**

## 1. Suite sebelum review
verify (build, typecheck, lint, core 143/1 skip, server 23, web 4, smoke) · UI Chrome 20/20 · E2E 18/18 · prototype 56/56 — semua hijau.

## 2. Review independen
Subagent reviewer hanya diberi PRD, ADR-002, rencana v2.0 dan diff (tanpa kesimpulan pelaksana). Read-only. 9 temuan: 1 High, 3 Medium, 5 Low. Temuan High dan Medium pertama direproduksi reviewer dengan skrip terhadap `packages/core/dist`, lalu direproduksi ulang oleh pelaksana sebelum diperbaiki.

| ID | Sev | Temuan | Status | Perbaikan + bukti |
|---|---|---|---|---|
| F1 | High | Restore lewat HTTP menerima `destination` bebas di area media, termasuk nama `.importing-*`; recovery startup menyapu `.importing-*` berumur >24 jam tanpa cek registry → **file aktif terhapus permanen tanpa persetujuan**. Juga bisa memindah media proyek A ke scope lain | **fixed** | (1) recovery hanya menyapu nama persis `^\.importing-op_[0-9a-f]{16}$` dan **tidak pernah** path yang ada di registry; (2) restore: tujuan eksplisit wajib di scope media sendiri (shared → `SHARED_MEDIA/`, proyek → `PROJECTS/<id>/01_INPUT/`) dan nama tidak boleh diawali titik; (3) field `destination` dicabut dari API HTTP. Tes: `checkpointD-regressions.test.ts` (4 tes F1), `apps/server/test/checkpointD.test.ts` F1. Skrip repro reviewer sekarang ditolak `PATH_INVALID` |
| F2 | Med | Satu folder bernama tak valid di `PROJECTS` (mis. `Old~1`) atau input proyek yang berupa junction → dashboard error dan **server gagal start** (regresi W02: `listFiles` validasi ketat; recovery tanpa try/catch per area/file) | **fixed** | `listFiles` mulai dari path kanonik (link ditolak, tidak diikuti); recovery: ID tak valid dilewati, error per area/file dicatat di `report.skipped` (audit `alert`), tidak pernah membatalkan startup; dashboard: peringatan `AREA_UNREADABLE`; cleanup cache melewati ID tak valid. Index dependensi tetap fail-closed (GC diblok) — sesuai PRD. Tes: 2 tes F2 (nama 8.3 + junction berisi file temp-like di luar workspace: tidak disentuh) |
| F3 | Med | Upload > 5 menit diputus (default `requestTimeout` Node 300 dtk) | **fixed** | `requestTimeout = 0`, socket idle 2 menit ditutup (`server.timeout`), idle timeout per upload. Tes konfigurasi |
| F4 | Med | Upload paralel lolos cek ruang masing-masing; temp di volume sama butuh 2× tapi dicek 1×; upload ke proyek tak ada diterima dulu baru 404; folder temp sisa crash tak dibersihkan | **fixed** | satu import per server (yang kedua `409 BUSY`); cek ruang 2× bila temp & workspace satu volume; proyek dicek sebelum membaca body; `sweepUploadTemp` saat startup (hanya prefix `motion-upload-`, tak berubah ≥6 jam). Tes: BUSY dengan upload setengah jalan, 404 tanpa file temp, sweep stale/fresh/asing |
| F5 | Low | Path absolut bocor: `String(e)` di alasan restore/purge, `recent_audit` di dashboard | **fixed** | alasan memakai kode error (`ENOENT`/`IO_ERROR`), dashboard HTTP tanpa `recent_audit`. Tes F5 |
| F6 | Low | Dashboard menjalankan scan sebagai aktor `ai` (audit tertulis "ai") dan me-rehash kandidat tiap muat | **open (diterima sementara)** | desain T14 (scan dry-run read-only). Menjadi masalah saat video besar nyata → ditangani paling lambat W07 (preview/cache): mode scan baca-saja tanpa audit/hash atau cache hasil scheduler |
| F7 | Low | Purge hanya butuh token sesi; skrip lokal pemegang token bisa prepare+execute tanpa manusia | **open (constraint dicatat)** | aturan untuk W11: kode AI/Copilot **tidak boleh** memakai sesi user; pertimbangkan konfirmasi kedua khusus UI untuk purge sebelum W11/W09 |
| F8 | Low | `commit`/`move` bisa menimpa (rename menimpa di Windows/POSIX), bertentangan dengan kontrak backend | **fixed** | `renameNoReplace`: hard link atomik (EEXIST → CONFLICT) + unlink, mode file dipertahankan; fallback cek+rename di volume tanpa link (exFAT) di bawah lock. Tes F8 + kontrak backend |
| F9 | Low | Celah tes/tooling: `npm test` bisa menguji core basi, aturan ESLint tidak untuk `.tsx`, dependensi effect MediaView, CI tanpa e2e/ui | **fixed** (sebagian) | `npm test` build dulu; lint `.tsx`; effect diperbaiki; CI menjalankan `test:e2e` + `test:ui`. Plugin `react-hooks` **tidak** ditambahkan (dependency baru) — dicatat |

## 3. Lain-lain
- Tes lock Checkpoint A (H2 "many contenders…") **sekali gagal** saat suite penuh sedang berat; 5/5 lulus terisolasi dan 3× suite penuh setelahnya lulus. Dicatat sebagai flaky timing, belum diubah.
- Fixture ST-09 memakai nama temp buatan (`.importing-op_dead`); disamakan ke format asli `op_` + 16 hex. Kriteria tes sama.
- Permintaan owner yang masuk selama checkpoint (hapus metadata hasil render) dicatat sebagai syarat wajib W08.

## 4. Suite setelah perbaikan
verify: build, typecheck, lint, **core 150 pass / 1 skip** (+7 regresi), **server 29/29** (+6), web 4/4, smoke · UI Chrome 20/20 · E2E 18/18 · prototype 56/56 · core suite diulang 2× lagi: stabil.
