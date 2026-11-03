# Motion Studio Copilot

Desktop/hybrid, local-first video editor dengan AI Copilot. Status & urutan kerja: `PROGRESS.md` dan `docs/IMPLEMENTATION_PLAN_v1.0.md`. Source of truth: `docs/PRD_MASTER_v1.0.md`.

## Struktur
- `src/storage/` — storage core (workspace, registry media, dependency index, Smart GC, Trash, restore, purge manual, kuota, render preflight). Node/TypeScript, tanpa dependensi runtime. Lihat `docs/adr/ADR-001-*`.
- `test/` — unit & integration test (Vitest).
- `prototype/` — prototype UI HTML (referensi UI saja, bukan produk).
- `audit/` — laporan & bukti audit per task.

## Perintah
| Perintah | Fungsi |
|---|---|
| `npm ci` | install dependensi dev |
| `npm run verify` | typecheck + lint + test + build |
| `npm test` | unit/integration test |
| `npm run test:prototype` | audit browser prototype (butuh Google Chrome); bukti ke `.tmp/prototype-evidence` |

Butuh Node.js ≥ 20.11.
