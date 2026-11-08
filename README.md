# Motion Studio Copilot

Web app editor video dengan AI Copilot; file asli & hasil render di Google Drive (ADR-002). Status & urutan kerja: `PROGRESS.md` dan `docs/IMPLEMENTATION_PLAN_v2.0.md`. Source of truth: `docs/PRD_MASTER_v1.0.md`.

## Struktur
- `packages/core/` — storage core (workspace, registry media, dependency index, Smart GC, Trash, restore, purge manual, kuota, render preflight). Node/TypeScript, tanpa dependensi runtime. Lihat `docs/adr/ADR-001-*` dan `ADR-002-*`.
  - `src/storage/`, `src/cli/` — kode; `test/` — unit & integration test (Vitest).
- `apps/server/` — server API lokal (Node `http`, hanya 127.0.0.1, token sesi per start). `apps/web/` — UI web React + Vite (build ke `apps/web/dist`, disajikan server di `/`).
- `scripts/` — skrip bantu repo (smoke test layout).
- `prototype/` — prototype UI HTML (referensi UI saja, bukan produk).
- `audit/` — laporan & bukti audit per task.

Satu paket npm (bukan npm workspaces): drive D: memakai exFAT yang tidak mendukung symlink/junction yang dibutuhkan workspaces. Antar folder disambung lewat TypeScript project references (`tsc -b`).

## Perintah
| Perintah | Fungsi |
|---|---|
| `npm ci` | install dependensi dev |
| `npm run verify` | build + typecheck + lint + test + smoke |
| `npm run start:server` | build lalu jalankan server; set `MOTION_WORKSPACE` (folder workspace yang sudah di-init), opsional `MOTION_PORT` (default 4317), `MOTION_UPLOAD_TMP` (temp upload, di luar workspace), `MOTION_GC` (`on` default, `scan-only`, `off`), `MOTION_FFPROBE` (path ffprobe, default dari PATH), `MOTION_FFMPEG` (path ffmpeg ≥7, default dari PATH), `MOTION_RENDER_TMP` (folder kerja render, di luar workspace; default temp OS), `MOTION_FONT` (font teks/subtitle; default Arial Bold/DejaVu Sans Bold). Login Google (W09): `MOTION_GOOGLE_CLIENT_ID` + `MOTION_GOOGLE_CLIENT_SECRET` + `MOTION_ALLOWED_EMAILS` (ketiganya = login Google wajib; sebagian = server menolak start), opsional `MOTION_PUBLIC_URL`, `MOTION_STATE_DIR`, `MOTION_SECRET_KEY`; bisa ditaruh di `.env.local` (lihat `.env.example`, panduan `docs/SETUP_GOOGLE_LOGIN.md`). Tanpa Google: URL berisi token dicetak di terminal. Daftar endpoint: `PROGRESS.md` baris W04 |
| `npm test` | unit/integration test |
| `npm run test:ui` | build lalu uji UI di Chrome nyata (W05 halaman + W06 editor timeline + W07 pratinjau + W08 render MP4 + W09 login Google + W11 Copilot + W12 AI + W13 anggaran + W14 transkrip; bukti + screenshot ke `audit/W05|W06/evidence`) |
| `npm run test:e2e` | build lalu acceptance run dengan MP4 nyata |
| `npm run test:prototype` | audit browser prototype (butuh Google Chrome); bukti ke `.tmp/prototype-evidence` |

Butuh Node.js ≥ 20.11.
