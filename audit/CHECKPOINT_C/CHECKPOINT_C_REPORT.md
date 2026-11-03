# CHECKPOINT C — audit T11–T15 (audit akhir)

Tanggal: 2026-11-04 · Status: **LULUS setelah perbaikan**

## Suite penuh
| Suite | Sebelum | Sesudah |
|---|---|---|
| `npm run verify` (typecheck, lint, test, build) | 126 pass / 1 skip | **133 pass / 1 skip** (stabil 3x) — `verify_log.txt` |
| `npm run test:e2e` (build + MP4 nyata, GC-01..GC-12 + design check M-1..M-5 + crash) | 18/18 | **18/18** — `e2e_log.txt`, `e2e_results.json` |
| `npm run test:prototype` | 56/56 | 56/56 |

## Review independen (subagent; PRD + ADR + diff saja)
Reviewer mengonfirmasi tiap temuan dengan tes buatan sendiri di salinan repo.

| ID | Kep. | Temuan | Perbaikan | Tes regresi |
|---|---|---|---|---|
| H1 | High | Recovery bisa menghapus satu-satunya salinan versi di Trash (trash selesai, crash sebelum journal dihapus, user menaruh file di path asli) | Cek "registry sudah di tujuan" lebih dulu; hapus hanya bila terbukti duplikat (inode sama, atau hash identik di folder Trash milik kita); selain itu dibiarkan + alert | C-H1 |
| H2 | High | Recovery menghapus file user di tujuan restore; path journal tidak dicek area (journal dimanipulasi bisa menghapus output/metadata) | Path journal wajib di area yang benar per jenis (trash: media→.trash, restore: .trash→media, purge: .trash); invalid → journal disimpan untuk review, GC tetap diblok; tujuan tak terbukti tidak pernah dihapus | C-H2 ×2 |
| M1 | Medium | Purge mengabaikan journal korup | Journal tak terbaca → semua item purge diblok `JOURNAL_CORRUPT` | C-M1 |
| M2 | Medium | Crash di tengah purge tanpa jejak | Journal `purge` + audit `phase: started` sebelum hapus; recovery mencatat `purged` bila file sudah hilang, `not-started` bila masih ada | C-M2 ×3 |
| M3 | Medium | `approve_overwrite` diterima dari scheduler | Hanya aktor `user`; selain itu FORBIDDEN + audit | C-M3 |
| M4 | Medium | Dua render antre mendapat nama output sama | Nama output dicadangkan di lease (`output_rel`); preflight + lease dalam satu lock | C-M4 (paralel → x.mp4 & x_v2.mp4) |
| L1 | Low | Cek lease-vs-preflight tidak pernah bisa gagal (kode mati) | Dihapus; preflight & lease satu lock; perubahan eksternal ditangkap `verifyRenderSnapshot` | T15 |
| L2 | Low | Recovery menghapus `.importing-*` milik import yang sedang berjalan | Hanya temp > 24 jam yang disapu | ST-09 sweep |
| L3 | Low | Restore selesai + crash → manifest Trash tertinggal | Recovery merapikan manifest & folder kosong | — (jalur completed) |
| L4 | Low | Rollback hard link membuat byte Trash writable | Re-chmod read-only setelah unlink | ST-09 extra-link |
| L5 | Low | Percobaan salah menghanguskan request purge | Disengaja (anti-replay); didokumentasikan di kode & laporan | ST-08 |
| T | Tes | Tes scheduler "locked/errors" tidak menguji keduanya; tes partial-destination tidak membuktikan file parsial | Tes diperbaiki: lock asing hidup → `skipped-locked`; provider melempar error → `error` + audit; partial → dibiarkan | ST-09 |

Juga ditemukan saat checkpoint: skenario crash di E2E memakai versi yang sudah di Trash (journal tidak realistis) — kode lama menerimanya, kode baru menolaknya dengan benar. Skenario diganti ke versi aktif.

## Area bersih (konfirmasi reviewer)
Tidak ada jalur AI/scheduler/peringatan kuota untuk purge; cleanup cache terkunci ke `04_CACHE` kanonik; verifikasi backup read-only; token purge tidak pernah disimpan mentah atau di-log; tidak ada TODO/stub.
