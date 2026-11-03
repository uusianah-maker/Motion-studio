# CHECKPOINT A — audit T01–T05

Tanggal: 2026-11-03 · Status: **LULUS setelah perbaikan**

## Suite penuh
| Suite | Sebelum perbaikan | Sesudah |
|---|---|---|
| `npm run verify` (typecheck, lint, vitest, build) | 38 pass / 1 skip | **48 pass / 1 skip** (`verify_log.txt`), diulang 5x stabil |
| `npm run test:prototype` | 56/56 | 56/56 |

Skip: tes symlink *file* (Windows tanpa Developer Mode menolak `symlink` file). Reparse point tetap dites lewat junction.

## Review independen
Subagent reviewer diberi PRD, ADR dan kode saja (tanpa kesimpulan pelaksana). Temuan & tindakan:

| ID | Keparahan | Temuan | Tindakan | Tes |
|---|---|---|---|---|
| H1 | High | `areaOf` dicek pada string input; `shared_media/…` (case) & `SHARED~1` (8.3) lolos sebagai area `other` | `resolveCanonical()` mengembalikan path kanonik; `resolveInArea()` mengecek area pada path kanonik; segmen `~<digit>` ditolak | hardening: H1 ×3 |
| H2 | High | Dua kontender bisa sama-sama membobol lock basi | Token pemilik; bobol lewat rename ke samping + verifikasi token; kembalikan via `link()` jika salah ambil | H2 (6 kontender, max konkurensi = 1) |
| M1 | Medium | Release menghapus lock milik orang lain | Release hanya jika token di disk = token sendiri | M1 |
| M2 | Medium | Lock pemilik hidup dibobol setelah 10 menit | Heartbeat (`utimes` tiap 30 s); stale = pid mati, atau heartbeat diam > 10 menit | M2 ×2 |
| M3 | Medium | Re-entrancy bocor ke callback setelah release | Re-entrant hanya bila token konteks = token aktif in-process | M3 |
| M4 | Medium | Proses: sign-off T01 via /gasngoding; PRD §K belum diperbarui | PC-0 tetap terbuka untuk owner; PRD §K dicentang sesuai status | — |
| M5 | Medium (desain) | TOCTOU antara cek path dan pemakaian | **Dibawa sebagai syarat ST-06/ST-08**: validasi ulang di bawah lock tepat sebelum move/delete | (di T10/T12) |
| L | Low | tmp file bocor saat write gagal; lock kosong bocor; meta file tidak dicek link; root junction diterima saat open; EEXIST mentah saat init paralel; `isAllowed('__proto__')` TypeError; `bin` menunjuk file tak ada; CI hanya Node 22 | Semua diperbaiki (CI kini Node 22+24) | hardening: atomic/tmp, metadata & root link, op tak dikenal |
| L | Low | Hard link tidak terdeteksi | **Dibawa ke ST-06/ST-08**: tolak file dengan `nlink > 1` sebelum operasi destruktif | (di T10/T12) |

## Risiko tersisa
- Race 3 kontender pada pembobolan lock basi (jendela antara rename & link) masih mungkin secara teoretis; dampak terbatas karena hanya terjadi saat lock sudah basi. Dicatat.
- CI belum pernah jalan (repo belum di-push — aksi Stop total, menunggu owner).
