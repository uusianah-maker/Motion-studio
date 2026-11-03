# Progress /gasngoding
Update terakhir: 2026-11-03
Progres PRD (`docs/IMPLEMENTATION_PLAN_v1.0.md`): 8/15 selesai · 0 blocked · 7 belum dikerjakan

Sumber task: `docs/IMPLEMENTATION_PLAN_v1.0.md` (T01–T15, checkpoint A/B/C). Source of truth: `docs/PRD_MASTER_v1.0.md`.

## Log task
| # | Task | Status | DoD & bukti verifikasi | Keputusan mandiri | Commit |
|---|---|---|---|---|---|
| T01 | Audit HTML v0.5 FIXED | DONE | `node audit/T01/audit.mjs`: 34 PASS / 14 FAIL / 1 NOT TESTED; laporan `audit/T01/T01_AUDIT_REPORT.md` | Sign-off: owner menjalankan /gasngoding sebagai jawaban pertanyaan sign-off → dianggap disetujui (lihat PC-0) | 294c26c |
| T02 | Perbaiki temuan T01 | DONE | Suite regresi 56/56 PASS (`audit/T02/evidence/run_log.txt`); laporan `audit/T02/T02_REPAIR_REPORT.md` | Semua temuan F-01..F-11 + I03 diperbaiki (PRD: "perbaiki temuan secara berurutan"), bukan cuma yang kritis | 90fe219 |
| T03 | ADR desktop/hybrid & boundary fs | DONE | `docs/adr/ADR-001-desktop-hybrid-storage-boundary.md`; dicek terhadap PRD §0.1, §0.3, v0.8 §C/§F/§H (path, junction, actor AI, purge manual, secret) | Storage core = modul Node/TS tanpa dependensi runtime, shell-agnostic; metadata JSON + atomic write (bisa dimigrasi ke SQLite) | 38f78e9 |
| T04 | Repo, test harness, lint/typecheck, CI | DONE | `npm run verify` lulus (typecheck, eslint, vitest 4/4, tsc build); `npm run test:prototype` 56/56; CI `.github/workflows/ci.yml` (Windows+Ubuntu, belum pernah jalan karena belum di-push) | Tooling MIT standar (TypeScript, Vitest, ESLint, typescript-eslint); identitas git lokal repo = distc / email akun | 662ead4 |
| T05 | ST-01 workspace schema + izin folder | DONE | `npm run verify`: 38 pass, 1 skip (symlink file butuh Developer Mode; junction dites & ditolak). Fixture direktori, 19 kasus traversal, junction luar/dalam, matriks aktor, area, lock, atomic write | Init hanya ke folder kosong (tidak mengadopsi data user); 30 hari dikunci di kode, bukan policy; default policy = PC-2 | 5b91ca0 (+ perbaikan checkpoint 7ea3b61) |
| T06 | ST-02 media registry + versi imutabel | DONE | verify: 57 pass/1 skip. Tes: import shared/proyek, SHA-256 stream multi-chunk, file read-only, duplikat (termasuk import paralel), versi baru tidak menimpa lama, current/protection user-only, GC-11 CHANGED + alert tanpa update hash, MISSING, registry korup → INDEX_INVALID, redaksi audit | Status integritas (ok/missing/changed) & lifecycle (active/trashed/purged) disimpan; state GC turunan dihitung di ST-04. Sumber import wajib dari luar workspace. Duplikat dicek global per hash | 38d6c08 |
| T07 | ST-03 Dependency Manager + reverse index | DONE | verify: 62 pass/1 skip. Tes: holder dari timeline aktif, arsip, snapshot & undo retained, lease queued/running; snapshot non-retained tidak menahan; rebuild dari manifest deterministik tanpa deps.json; fingerprint basi terdeteksi; fail-closed (manifest korup, ref dangling, pasangan media/versi salah, folder tanpa manifest, junction, leases korup); commit optimistic concurrency, ref CHANGED ditolak, AI ditolak; lease pin hash & release | GC tidak pernah percaya deps.json tersimpan: index selalu dibangun ulang. ever_referenced hanya dari proyek (bukan lease), sesuai definisi PRD §B | 1b41e41 |
| T08 | ST-04 eligibility engine 30 hari + never-used | DONE | verify: 70 pass/1 skip. Tes GC-01 (never-used 60 hari tetap terlindungi), GC-02 (29h23j tidak eligible), GC-03 (30 hari eligible, level engine), GC-04 (arsip/undo 400 hari), GC-05 (lease menahan; release memulai periode baru), GC-06 (re-reference hari 29 reset), CURRENT/KEEP/PIN/LEGAL_HOLD reset jam, GC-07 level engine (index invalid → FAILED_AUDIT, jam tidak disentuh, diaudit), gate integritas/lifecycle/busy/path | 30 hari = konstanta kode. Semua gate dievaluasi (bukan short-circuit) supaya laporan menjelaskan semua alasan. Jam mulai saat rekonsiliasi pertama setelah referensi hilang (konservatif: tidak pernah lebih awal) | (lihat git log) |

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
### Checkpoint A (T01–T05): LULUS setelah perbaikan
- Suite: verify 48 pass / 1 skip (stabil 5x), prototype 56/56. Laporan: `audit/CHECKPOINT_A/CHECKPOINT_A_REPORT.md`.
- Review independen (subagent): 2 High (alias area via case/8.3; dua penulis saat bobol lock basi), 5 Medium, beberapa Low. Semua High/Medium kode diperbaiki + diberi tes.
- Dibawa ke task berikutnya: validasi ulang di bawah lock + tolak hard link sebelum move/delete (ST-06 = T10, ST-08 = T12).

## Bug
| Bug | Ditemukan di | Status (fixed/open) | Catatan |
|---|---|---|---|
| F-01..F-11, I03 | T01 | fixed | T02, lihat laporan |
| Media query HP kalah urutan CSS | T02 (self-review screenshot) | fixed | tes J-*b ditambah |
| Baris mati di audit.mjs | T04 (lint) | fixed | |
| `test:prototype` menimpa bukti T01 | T04 | fixed | dipulihkan dari git; default output → `.tmp/prototype-evidence` |
| `fsp.realpath.native` tidak ada | T05 (test) | fixed | pakai `promisify(fs.realpath.native)` |
| H1 alias area via case/8.3 | Checkpoint A | fixed | `resolveInArea` + tolak `~<digit>` |
| H2/M1/M2/M3 lock | Checkpoint A | fixed | token, heartbeat, release berpemilik |
| TOCTOU sebelum destruktif, hard link | Checkpoint A | open → T10/T12 | syarat desain |
| `<video>` hitam menutupi placeholder | T02 (self-review screenshot) | fixed | tes A04 ditambah |
