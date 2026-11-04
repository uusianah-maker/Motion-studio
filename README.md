# Motion Studio Copilot

Web app editor video dengan AI Copilot; file asli & hasil render di Google Drive (ADR-002). Status & urutan kerja: `PROGRESS.md` dan `docs/IMPLEMENTATION_PLAN_v2.0.md`. Source of truth: `docs/PRD_MASTER_v1.0.md`.

## Struktur
- `packages/core/` — storage core (workspace, registry media, dependency index, Smart GC, Trash, restore, purge manual, kuota, render preflight). Node/TypeScript, tanpa dependensi runtime. Lihat `docs/adr/ADR-001-*` dan `ADR-002-*`.
  - `src/storage/`, `src/cli/` — kode; `test/` — unit & integration test (Vitest).
- `apps/server/` — server API (dibuat di W03). `apps/web/` — UI web (dibuat di W05).
- `scripts/` — skrip bantu repo (smoke test layout).
- `prototype/` — prototype UI HTML (referensi UI saja, bukan produk).
- `audit/` — laporan & bukti audit per task.

Satu paket npm (bukan npm workspaces): drive D: memakai exFAT yang tidak mendukung symlink/junction yang dibutuhkan workspaces. Antar folder disambung lewat TypeScript project references (`tsc -b`).

## Perintah
| Perintah | Fungsi |
|---|---|
| `npm ci` | install dependensi dev |
| `npm run verify` | typecheck + lint + test + build + smoke |
| `npm test` | unit/integration test |
| `npm run test:e2e` | build lalu acceptance run dengan MP4 nyata |
| `npm run test:prototype` | audit browser prototype (butuh Google Chrome); bukti ke `.tmp/prototype-evidence` |

Butuh Node.js ≥ 20.11.
