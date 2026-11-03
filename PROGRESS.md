# Progress /gasngoding
Update terakhir: 2026-11-04
Progres PRD (`docs/IMPLEMENTATION_PLAN_v1.0.md`): 15/15 selesai · 0 blocked · 0 belum dikerjakan

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
| T08 | ST-04 eligibility engine 30 hari + never-used | DONE | verify: 70 pass/1 skip. Tes GC-01 (never-used 60 hari tetap terlindungi), GC-02 (29h23j tidak eligible), GC-03 (30 hari eligible, level engine), GC-04 (arsip/undo 400 hari), GC-05 (lease menahan; release memulai periode baru), GC-06 (re-reference hari 29 reset), CURRENT/KEEP/PIN/LEGAL_HOLD reset jam, GC-07 level engine (index invalid → FAILED_AUDIT, jam tidak disentuh, diaudit), gate integritas/lifecycle/busy/path | 30 hari = konstanta kode. Semua gate dievaluasi (bukan short-circuit) supaya laporan menjelaskan semua alasan. Jam mulai saat rekonsiliasi pertama setelah referensi hilang (konservatif: tidak pernah lebih awal) | b050c29 |
| T09 | ST-05 candidate scanner (dry-run) + audit log | DONE | verify: 78 pass/1 skip. Fixture 9 kategori → kandidat persis = {A,B}; file tree tidak berubah (hash seluruh file); byte diubah diam-diam → ditolak CHANGED + flag; file hilang → UNVERIFIABLE + missing; busy dikecualikan; GC-07 berhenti aman + audit 'blocked'; AI scan tidak menulis apa pun selain audit; service: jam mulai tepat saat referensi/proteksi/lease hilang | Ditambah fasad `StorageService` (ADR D1) yang merekonsiliasi jam di lock yang sama setelah tiap mutasi — temuan saat T09: tanpa ini jam baru mulai saat scan berikutnya | 78be3da |
| T10 | ST-06 Auto Trash engine | DONE | verify: 86 pass/1 skip. Tes GC-03 (pindah + manifest + registry + audit akurat), GC-10 (freed_bytes = 0 di volume sama), GC-01/02/04/05 tidak pernah dipindah (+ current), GC-07 (data dependensi korup → 0 pindah, diaudit), GC-12 (AI ditolak + diaudit), validasi ulang tepat sebelum pindah (byte berubah & hard link di-skip), busy & idempotensi, versi di Trash tidak bisa di-commit | Journal intent ditulis sebelum pindah (dipakai recovery T13). Fallback lintas-drive: copy → verifikasi hash → hapus original. freed_bytes selalu 0 (tidak pernah klaim ruang bebas) | d86fa6c |
| T11 | ST-07 restore + collision handling | DONE | verify: 91 pass/1 skip. Tes: restore ke path asli (read-only lagi, referensi valid lagi, periode 30 hari baru), GC-09 tujuan terisi tidak ditimpa → conflict + saran / alternate / path eksplisit, tujuan wajib area media, file Trash rusak/hilang → failed (bukan klaim sukses), user-only + diaudit, bukan-trashed ditolak | Pindah tanpa overwrite via link() atomik (EEXIST) lalu unlink; fallback copy eksklusif + cek hash | 1dc21aa |
| T12 | ST-08 manual permanent delete + explicit approval | DONE | verify: 105 pass/1 skip. Tes GC-08 (detail dialog: nama, ukuran, ID, proyek pereferensi, irreversible, status backup; token sekali pakai + frasa HAPUS PERMANEN; audit ulang terkunci), tanpa masa tunggu (1 hari di Trash bisa dihapus), token salah/frasa salah/kedaluwarsa/replay/unknown ditolak & diaudit, AI & scheduler tidak bisa (GC-12), proteksi ditambah setelah prepare → diblok, index invalid → semua diblok, hash rusak/hard link/bukan-Trash diblok, 365 hari di Trash tidak pernah di-purge otomatis; backup hanya terverifikasi lewat hash (read-only, folder harus di luar workspace) | Token disimpan hanya sebagai SHA-256 dan hangus pada percobaan pertama (gagal pun). Modul backup.ts dibuat di sini karena dialog purge wajib menampilkan status verifikasi backup | ed4bdfb |
| T13 | ST-09 scheduler + crash recovery | DONE | verify: 114 pass/1 skip. Simulasi crash: setelah pindah sebelum registry → rollback; sebelum pindah → no-op; copy terputus → tujuan parsial dihapus; selesai tapi journal tertinggal → dibersihkan; byte hilang → missing; restore terputus → kembali ke Trash lalu bisa diulang; journal korup → Auto Trash diblok + dilaporkan; sweep .importing-*/.tmp; file yatim dilaporkan tidak dihapus; idempoten. Scheduler: launch = recovery + siklus langsung + interval policy, tanpa overlap, error tidak lolos, busy provider, mode scan-only | Kebijakan recovery = selalu rollback ke kondisi sebelum operasi (keputusan GC diulang dari data segar, tidak pernah menyelesaikan keputusan basi). Scheduler tidak pernah purge | 91f176d |
| T14 | ST-10 disk quota + storage dashboard | SELESAI (backend + CLI); UI dashboard menunggu PC-1 | verify: 120 pass/1 skip. Tes: pemakaian per area + statfs nyata; disk penuh/kuota hanya memberi peringatan, tidak pernah Trash/purge (design check 5); estimasi ruang import/render vs cadangan, fail closed bila tak terbaca; cleanup cache hanya 04_CACHE, terlama dulu, lewati file dipakai job, original & output aman, AI ditolak; dashboard (ringkasan GC, kapan versi jadi eligible, Trash + status backup, operasi tertunda, audit terbaru); CLI init/dashboard/scan/recover dijalankan nyata dari dist | Dashboard memakai scan dry-run aktor AI (read-only). CLI sengaja TIDAK membuka Auto Trash/restore/purge. Tampilan dashboard di app desktop belum dibuat karena shell belum diputuskan (PC-1) | 228aa8c |
| T15 | Integrasi render preflight + snapshot dependensi | DONE | verify: 126 pass/1 skip. Tes: snapshot persis (versi + hash), output versioned di 05_OUTPUT (final_v2), overwrite hanya dengan persetujuan eksplisit; media hilang/berubah → gagal eksplisit + usulan relink tanpa substitusi; versi lebih baru dilaporkan tapi TIDAK dipakai; media di Trash, disk kurang, timeline kosong, nama output traversal/subfolder, AI ditolak; GC-05 lease render 60 hari tidak di-Trash + snapshot tetap terverifikasi + jam mulai saat render selesai; bytes berubah saat render terdeteksi | Probe tulis (buat+hapus file) dipakai karena access() tidak andal di Windows. Render preflight hanya membaca timeline (bukan snapshot undo) | fe0484b |

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

### PC-3: Lompatan jam sistem
- Konteks: kalau jam Windows dimajukan (manual/salah sinkron), media lama bisa langsung dianggap lewat 30 hari.
- Opsi A: deteksi lompatan maju > 2 hari sejak scan terakhir → Auto Trash ditahan sampai user konfirmasi.
- Opsi B: percaya jam sistem (perilaku sekarang).
- Rekomendasi: A. Murah, dan cocok dengan prinsip fail-closed.

### PC-4: Urutan backlog setelah storage
- Task terdampak: semua pekerjaan sesudah T15 (PRD: "urutan rinci wajib disetujui sebelum dikerjakan").
- Konteks: storage core selesai. Backlog: editor timeline, media browser, captions, templates, export/render FFmpeg, AI planner/router, manual API enrollment, provider failover, E2E UI.
- Opsi A (rekomendasi): 1) shell desktop + UI dasar (butuh PC-1) → 2) editor timeline inti (trim/split/move/undo) di atas skema proyek yang sudah ada → 3) render MP4 nyata FFmpeg (memakai render preflight + lease T15) → 4) Copilot planner lokal → JSON edit plan → approval → 5) AI Provider Manager + failover → 6) captions/STT.
- Opsi B: AI planner/provider dulu, editor & render belakangan.
- Rekomendasi: A. Pengguna butuh edit & render nyata dulu; AI tanpa editor/render tidak menghasilkan video.

## Audit
### Checkpoint A (T01–T05): LULUS setelah perbaikan
- Suite: verify 48 pass / 1 skip (stabil 5x), prototype 56/56. Laporan: `audit/CHECKPOINT_A/CHECKPOINT_A_REPORT.md`.
- Review independen (subagent): 2 High (alias area via case/8.3; dua penulis saat bobol lock basi), 5 Medium, beberapa Low. Semua High/Medium kode diperbaiki + diberi tes.
- Dibawa ke task berikutnya: validasi ulang di bawah lock + tolak hard link sebelum move/delete (ST-06 = T10, ST-08 = T12).

### Checkpoint B (T06–T10): LULUS setelah perbaikan
- Suite: verify 98 pass / 1 skip, prototype 56/56. Laporan: `audit/CHECKPOINT_B/CHECKPOINT_B_REPORT.md`.
- Review independen: 1 High (jam 30 hari tidak reset bila referensi dibuat saat index invalid → Trash terlalu cepat), 5 Medium, 5 Low. High + semua Medium + L1/L3 diperbaiki dengan tes regresi.
- Owner (2026-11-04): "jalankan dulu semua end to end, konfirmasi nanti kalau sudah 90%" → lanjut tanpa jeda konfirmasi; PC dikumpulkan di akhir.

### Checkpoint C (T11–T15, audit akhir): LULUS setelah perbaikan
- Suite: verify 133 pass / 1 skip (stabil 3x), E2E 18/18 (build + MP4 nyata: GC-01..GC-12, design check M-1..M-5, crash recovery), prototype 56/56. Laporan: `audit/CHECKPOINT_C/CHECKPOINT_C_REPORT.md`.
- Review independen: 2 High (recovery bisa menghapus satu-satunya salinan di Trash; recovery bisa menghapus file user / mengikuti path journal di luar area), 4 Medium (purge abaikan journal korup; crash purge tanpa jejak; overwrite render oleh non-user; nama output render bentrok), 5 Low. Semua diperbaiki + tes regresi.

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
| Jam tidak reset saat index invalid (H1-B) | Checkpoint B | fixed | reset di titik mutasi |
| Trash gagal di tengah tanpa rollback (M2-B) | Checkpoint B | fixed | rollback + stop |
| Dedup import salah scope/Trash (M5-B) | Checkpoint B | fixed | |
| Orphan file setelah crash import | Checkpoint B | fixed (T13) | temp disapu, file yatim dilaporkan |
| Lompatan jam sistem (L2-B) | Checkpoint B | open (risiko) | PC-3 |
| Recovery menghapus salinan tunggal / file user (H1/H2-C) | Checkpoint C | fixed | bukti inode/hash + cek area journal |
| Purge: journal korup & crash tanpa jejak (M1/M2-C) | Checkpoint C | fixed | journal purge + audit started |
| Render: overwrite non-user & nama output bentrok (M3/M4-C) | Checkpoint C | fixed | reservasi output di lease |
| TOCTOU sebelum destruktif, hard link | Checkpoint A | fixed (Trash T10, purge T12) | `revalidateFile()`, cek nlink di purge |
| Jam 30 hari baru mulai saat rekonsiliasi berikutnya, bukan saat referensi hilang | T09 (test) | fixed | `StorageService` rekonsiliasi di dalam lock setelah tiap mutasi; tes `service.test.ts` |
| `<video>` hitam menutupi placeholder | T02 (self-review screenshot) | fixed | tes A04 ditambah |
