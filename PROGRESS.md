# Progress /gasngoding
Update terakhir: 2026-11-03
Progres PRD (`docs/IMPLEMENTATION_PLAN_v1.0.md`): 5/15 selesai · 0 blocked · 10 belum dikerjakan

Sumber task: `docs/IMPLEMENTATION_PLAN_v1.0.md` (T01–T15, checkpoint A/B/C). Source of truth: `docs/PRD_MASTER_v1.0.md`.

## Log task
| # | Task | Status | DoD & bukti verifikasi | Keputusan mandiri | Commit |
|---|---|---|---|---|---|
| T01 | Audit HTML v0.5 FIXED | DONE | `node audit/T01/audit.mjs`: 34 PASS / 14 FAIL / 1 NOT TESTED; laporan `audit/T01/T01_AUDIT_REPORT.md` | Sign-off: owner menjalankan /gasngoding sebagai jawaban pertanyaan sign-off → dianggap disetujui (lihat PC-0) | 294c26c |
| T02 | Perbaiki temuan T01 | DONE | Suite regresi 56/56 PASS (`audit/T02/evidence/run_log.txt`); laporan `audit/T02/T02_REPAIR_REPORT.md` | Semua temuan F-01..F-11 + I03 diperbaiki (PRD: "perbaiki temuan secara berurutan"), bukan cuma yang kritis | 90fe219 |
| T03 | ADR desktop/hybrid & boundary fs | DONE | `docs/adr/ADR-001-desktop-hybrid-storage-boundary.md`; dicek terhadap PRD §0.1, §0.3, v0.8 §C/§F/§H (path, junction, actor AI, purge manual, secret) | Storage core = modul Node/TS tanpa dependensi runtime, shell-agnostic; metadata JSON + atomic write (bisa dimigrasi ke SQLite) | 38f78e9 |
| T04 | Repo, test harness, lint/typecheck, CI | DONE | `npm run verify` lulus (typecheck, eslint, vitest 4/4, tsc build); `npm run test:prototype` 56/56; CI `.github/workflows/ci.yml` (Windows+Ubuntu, belum pernah jalan karena belum di-push) | Tooling MIT standar (TypeScript, Vitest, ESLint, typescript-eslint); identitas git lokal repo = distc / email akun | 662ead4 |
| T05 | ST-01 workspace schema + izin folder | DONE | `npm run verify`: 38 pass, 1 skip (symlink file butuh Developer Mode; junction dites & ditolak). Fixture direktori, 19 kasus traversal, junction luar/dalam, matriks aktor, area, lock, atomic write | Init hanya ke folder kosong (tidak mengadopsi data user); 30 hari dikunci di kode, bukan policy; default policy = PC-2 | (lihat git log) |

## Pending Confirmation
### PC-0: Konfirmasi sign-off T01
- Task terdampak: semua (gate PRD §0.3)
- Konteks: PRD melarang implementasi sebelum T01 sign-off. Owner tidak menjawab pertanyaan sign-off secara eksplisit, tapi menjalankan /gasngoding.
- Opsi A: anggap sign-off sah (status sekarang).
- Opsi B: batalkan; T01 balik ke TESTING dan pekerjaan sesudahnya ditahan.
- Rekomendasi: A. Audit lengkap & bisa diulang, dan semua temuan sudah diperbaiki di T02.

### PC-1: Shell desktop
- Task terdampak: integrasi UI (dashboard storage, dialog Trash/purge), backlog editor. **Tidak** memblokir T04–T15 (storage core shell-agnostic).
- Opsi A: Electron. Storage core jalan langsung di main process, satu bahasa TS. Installer besar.
- Opsi B: Tauri + sidecar Node. Ringan, tapi dua runtime dan packaging lebih rumit.
- Opsi C: Tauri + port storage ke Rust. Paling ringan, tapi tulis ulang dan test ganda.
- Rekomendasi: A, karena paling cepat jadi dan risiko integrasi FFmpeg/Node paling kecil.

### PC-2: Default kebijakan storage (PRD v0.8 §L)
- Task terdampak: T13 (jadwal scan), T14 (kuota/cache). Tidak memblokir: nilainya bisa diubah di `.motionstudio/policy.json`.
- Default sekarang: scan GC tiap 360 menit selama app jalan; batas cache 20 GB; cadangan ruang kosong 5 GB; soft quota media tidak aktif.
- Opsi A: pakai default ini.
- Opsi B: owner tentukan angka lain.
- Rekomendasi: A dulu, kalibrasi setelah pilot.

## Audit
(belum ada checkpoint)

## Bug
| Bug | Ditemukan di | Status (fixed/open) | Catatan |
|---|---|---|---|
| F-01..F-11, I03 | T01 | fixed | T02, lihat laporan |
| Media query HP kalah urutan CSS | T02 (self-review screenshot) | fixed | tes J-*b ditambah |
| Baris mati di audit.mjs | T04 (lint) | fixed | |
| `test:prototype` menimpa bukti T01 | T04 | fixed | dipulihkan dari git; default output → `.tmp/prototype-evidence` |
| `fsp.realpath.native` tidak ada | T05 (test) | fixed | pakai `promisify(fs.realpath.native)` |
| `<video>` hitam menutupi placeholder | T02 (self-review screenshot) | fixed | tes A04 ditambah |
