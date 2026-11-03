# IMPLEMENTATION PLAN v1.0
Status: PLANNED. Jangan mulai coding sebelum audit T01 sign-off.

## Urutan wajib
- [x] T01 Audit HTML v0.5 FIXED: inspeksi struktur, syntax, console, interaksi, pengujian browser; laporan bukti dan gap.
- [x] T02 Perbaiki temuan T01 secara berurutan, regression test; jika tak ada temuan, dokumentasikan N/A.
- [x] T03 Tetapkan architecture decision record desktop/hybrid dan boundary akses filesystem.
- [x] T04 Setup repository, test harness, lint/typecheck, dan CI minimal.
- [x] T05 Implementasi workspace schema + izin folder (ST-01).
**CHECKPOINT A:** audit lima tugas, repair sampai lulus, baru lanjut.
- [x] T06 Media registry + immutable version (ST-02).
- [x] T07 Dependency Manager + reverse index (ST-03).
- [x] T08 Eligibility engine 30 hari + never-used protection (ST-04).
- [x] T09 Candidate scanner + audit log (ST-05).
- [x] T10 Auto Trash engine (ST-06).
**CHECKPOINT B:** audit lima tugas, repair sampai lulus.
- [x] T11 Restore dan collision handling (ST-07).
- [ ] T12 Manual permanent delete + explicit approval (ST-08).
- [ ] T13 Scheduler + crash recovery (ST-09).
- [ ] T14 Disk quota + storage dashboard (ST-10).
- [ ] T15 Integrasi render preflight dan snapshot dependensi.
**CHECKPOINT C:** audit lima tugas, repair sampai lulus.

## Backlog setelah storage
- Editor timeline, media browser, captions, templates, export, AI planner/router, manual API enrollment, provider failover, pengujian E2E; urutan rinci wajib disetujui sebelum dikerjakan.

## Definition of Done per tugas
Acceptance criteria terpenuhi; unit/integration tests relevan lulus; diff dan keamanan diperiksa; checklist dan changelog diperbarui; commit hanya setelah review.
