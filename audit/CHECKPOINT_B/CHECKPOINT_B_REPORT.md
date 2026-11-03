# CHECKPOINT B — audit T06–T10 (+T11 ikut dicek ulang)

Tanggal: 2026-11-04 · Status: **LULUS setelah perbaikan**

## Suite penuh
| Suite | Sebelum | Sesudah |
|---|---|---|
| `npm run verify` | 86 pass / 1 skip | **98 pass / 1 skip** |
| `npm run test:prototype` | 56/56 | 56/56 |

## Review independen (subagent; diberi PRD, ADR, diff saja)
Reviewer mereproduksi 3 bug dengan tes buatan sendiri di salinan repo.

| ID | Kep. | Temuan | Perbaikan | Tes regresi |
|---|---|---|---|---|
| H1 | High | Referensi yang dibuat saat index invalid tidak me-reset jam 30 hari → versi bisa di-Trash 6 hari setelah terakhir dipakai | Reset `unreferenced_since = null` langsung di titik mutasi (commit, lease, KEEP/PIN/hold, set current), tidak tergantung index. Rekonsiliasi hanya *memulai* jam | `checkpointB-regressions` H1 (skenario reviewer persis) |
| M1 | Medium | Fungsi modul langsung (lease/protection) melewati reset jam | Sama dengan H1 (reset ada di fungsi modul, bukan hanya di service) | M1 |
| M2 | Medium | Gagal setelah file dipindah → file di Trash tapi registry `active`; objek in-memory sudah termutasi | Record diubah pada salinan & baru dipasang setelah tersimpan; gagal setelah pindah → file dikembalikan, manifest dihapus, journal dibersihkan; run berhenti di kegagalan pertama | M2 (registry dibuat read-only saat run) |
| M3 | Medium | Versi dengan journal belum selesai masih bisa direferensikan/di-lease | `assertUsable` menolak versi journal-busy; journal dipisah ke `journal.ts` | M3 |
| M4 | Medium | Audit item ditulis setelah journal dihapus; crash di antaranya = pindah tanpa log | Audit `phase: started` (semua field §E) sebelum pindah, `done` sebelum journal dihapus, `aborted` saat gagal | GC-03 diperketat (started+done) |
| M5 | Medium | Dedup import mengembalikan versi di Trash / media proyek lain | Dedup hanya versi `active` di scope sama atau shared; byte yang ada di Trash → CONFLICT + version_id | M5 |
| L1 | Low | `verifyVersion` bisa menyimpan hasil basi; error EBUSY/EACCES dicatat `missing` | Rekam hanya jika path & lifecycle tidak berubah; error non-ENOENT → `unverifiable`, tidak ditulis; AI tidak pernah menulis | L1 |
| L3 | Low | Hanya Auto Trash yang mengaudit penolakan AI | `guard()` mengaudit setiap penolakan (import, protection, commit, lease, scan, restore) | L3 |

## Dibawa ke task berikutnya / risiko
- **Orphan sweep** (file `m_*/v_*` tanpa registry & `.importing-*` setelah crash saat import) → T13 (crash recovery).
- **L2** jam sistem dimajukan → versi bisa langsung eligible. Mitigasi kandidat: deteksi lompatan jam > X hari & minta konfirmasi. Dicatat sebagai risiko (keputusan kebijakan, PC-3).
- **L4** Auto Trash memegang lock selama re-hash semua kandidat → operasi lain bisa `WORKSPACE_LOCKED` setelah 5 detik. Dicatat; dioptimalkan di T13 (batch per item).
- **L5** status "busy" (player/ekspor aktif) masih dari pemanggil, belum persisten lintas proses → bergantung integrasi UI (PC-1).
- Redaksi audit hanya berbasis nama field; teks error bebas tidak disaring (tidak memuat secret di storage core).
