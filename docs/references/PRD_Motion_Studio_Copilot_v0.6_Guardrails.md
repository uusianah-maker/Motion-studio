# PRODUCT REQUIREMENTS DOCUMENT — MOTION STUDIO COPILOT
Version: 0.6 | 27 October 2026 | Status: Guardrails added / implementation not yet audited

# ATURAN KERJA WAJIB — PRD EXECUTION GUARDRAILS (v0.6)

> Prioritas: aturan ini berlaku untuk seluruh proses pengerjaan Motion Studio Copilot. Bila bertentangan dengan rencana pengerjaan lama, hentikan perubahan dan minta keputusan owner. Aturan ini **tidak** mengubah ruang lingkup fitur tanpa persetujuan.

## A. Protokol komunikasi & pengambilan keputusan
1. Gunakan Bahasa Indonesia yang singkat, santai, dan gaya "bahasa bayi" sewajarnya, tetapi tetap presisi untuk istilah teknis, error, biaya, dan risiko.
2. Jawab langsung pada inti. Jangan menyetujui ide secara otomatis; jelaskan risiko/asumsi lemah dan berikan alternatif.
3. Owner adalah pengambil keputusan akhir terkait scope, biaya, prioritas, serta trade-off. Rekomendasi teknis bukan persetujuan otomatis.
4. **Setiap keputusan yang perlu dijawab owner** diajukan dalam pilihan ganda singkat (A/B/C) dengan satu opsi rekomendasi dan alasan. Jangan menambahkan pertanyaan untuk hal yang sudah diputuskan.

## B. Workflow wajib — jangan lompat urutan
1. **Sebelum mulai:** tampilkan daftar tugas yang akan dikerjakan, berurutan, lengkap dengan ID, output, dependensi, dan acceptance criteria. Cocokkan dengan urutan PRD. Mulai hanya dari tugas paling awal yang belum tuntas dan tidak terblokir.
2. **Satu tugas aktif dalam satu waktu:** status `TODO → IN PROGRESS → TESTING → DONE`, atau `BLOCKED`. Tugas berikutnya baru dimulai bila acceptance criteria tugas aktif lulus.
3. Jangan mengubah scope, mengerjakan tugas lebih maju, atau menandai tugas selesai hanya karena UI/placeholder tersedia. Jika dependensi bermasalah, hentikan urutan dan laporkan blocker; owner menentukan perubahan prioritas bila diperlukan.
4. **Setelah setiap 5 tugas yang benar-benar selesai:** jalankan audit checkpoint (kesesuaian PRD, fungsi aktual, regresi, keamanan, performa dasar, dan bukti uji). Jika audit gagal, buat pekerjaan perbaikan ber-ID, selesaikan dan uji ulang **sebelum** mengerjakan tugas berikutnya. Ulangi checkpoint sesudah perbaikan. Jika tinggal <5 tugas sebelum milestone/release, tetap audit pada akhir milestone.
5. **Sebelum commit:** review diff, cek kesesuaian scope dan acceptance criteria, jalankan test/lint/build yang tersedia, pastikan tidak ada secret bocor, dan catat hasil. Commit hanya bila semua pemeriksaan lulus. Jika belum ada repo/Git, laporkan `commit: belum tersedia`; jangan mengaku sudah commit.
6. Setelah pekerjaan selesai, selalu perbarui checklist dan changelog PRD dengan tanggal, ID tugas, status, bukti/test, temuan, perbaikan, dan next task. Jangan menandai DONE tanpa bukti.
7. Setiap bug/regresi pada tugas sebelumnya mengembalikan status terkait ke `IN PROGRESS` atau `BLOCKED`, bukan diabaikan agar bisa lanjut.

## C. Definition of Done per tugas
- Kode/artefak nyata tersedia, bukan mockup yang dipresentasikan sebagai fitur selesai.
- Acceptance criteria diverifikasi; catat cara uji dan hasil (`PASS`, `FAIL`, `NOT TESTED`).
- Tidak ada error blocking yang diketahui; edge case utama dan error state diperiksa.
- Dokumentasi/PRD dan checklist sesuai implementasi aktual.
- Review perubahan dan keamanan berhasil; baru status `DONE`.

## D. Format laporan wajib setiap tugas
`ID | Nama tugas | Status | File/komponen | Hasil uji + bukti | Temuan | Perbaikan | Next ID | Commit status`

## E. Checklist pelaksanaan (baseline per 27 Oktober 2026)
> Checklist ini adalah urutan kerja baru. `TODO` berarti **belum tervalidasi sebagai DONE**, bukan berarti tidak ada prototype. File HTML lama merupakan proof of concept; bukan bukti backend produksi.

- [ ] T01 — Inventaris artefak dan verifikasi fungsi prototype v0.5 FIXED; peta gap terhadap PRD, buat test baseline.
- [ ] T02 — Finalisasi skema proyek/timeline universal (tracks, clips, assets, operations, versioning).
- [ ] T03 — Implementasi proyek dan import aset yang konsisten dengan skema.
- [ ] T04 — Implementasi editor timeline inti: select, move, trim, split dan undo/redo.
- [ ] T05 — Preview timeline sinkron (teks/video/audio), rasio dan safe area.
- [ ] **AUDIT-01** — Audit menyeluruh T01–T05; perbaiki seluruh FAIL sebelum T06.
- [ ] T06 — Save/load proyek dan validasi skema.
- [ ] T07 — Render MP4 nyata dengan status job dan error handling.
- [ ] T08 — Prompt parser lokal → edit plan terstruktur dan tervalidasi.
- [ ] T09 — Diff/preview → approval → apply edit plan dengan idempotency/undo.
- [ ] T10 — AI Provider Manager manual (server-side encrypted secrets, akses admin, tes koneksi).
- [ ] **AUDIT-02** — Audit T06–T10; perbaiki seluruh FAIL sebelum T11.
- [ ] T11 — Provider adapter OpenAI/Gemini/Anthropic + custom sesuai API resmi.
- [ ] T12 — Capability router dan automatic failover lintas provider yang diotorisasi.
- [ ] T13 — Usage/cost tracking, hard budget cap, cooldown dan audit log.
- [ ] T14 — Caption/STT dan transcript editing.
- [ ] T15 — Scene detection/silence removal + automated clips.
- [ ] **AUDIT-03** — Audit T11–T15; perbaiki seluruh FAIL sebelum lanjut.
- [ ] T16+ — Fitur lanjutan dalam urutan P1/P2 (Brand Kit, collaboration, batch, B-roll, avatar/generative, dubbing), dipecah jadi tugas ber-ID sebelum dimulai.

## F. Log checkpoint dan commit
| Checkpoint | Status | Bukti | Temuan/perbaikan |
|---|---|---|---|
| Baseline | Belum diuji pada versi ini | HTML prototype sebelumnya tersedia; perlu test ulang | T01 wajib pertama |
| AUDIT-01 (T01–T05) | Pending | — | — |
| AUDIT-02 (T06–T10) | Pending | — | — |
| AUDIT-03 (T11–T15) | Pending | — | — |
| Commit | Belum dilakukan untuk v0.6 | Hanya pembaruan dokumen | Jangan klaim commit |

---

## 1. Product thesis
An AI-first, browser-based video editor where a user can either edit a deterministic multitrack timeline directly or instruct an agent in Bahasa Indonesia to prepare, preview, and apply proposed changes. The product combines Kapwing-like cloud editing/repurposing/collaboration and VEED-like AI-assisted creation, while differentiating on *editable, reviewable agent actions* and Indonesian commerce content workflows.

## 2. Problem and constraints
- Traditional editors require repetitive cutting, resizing, subtitling and overlays.
- One-prompt generators give weak control over precise edit decisions and cause unpredictable cost.
- Multi-editor teams need approvals, brand rules, asset provenance and safe versioning.
- Browser media performance, video export and AI generation require separate back-end infrastructure; front-end UI alone cannot guarantee production-quality rendering.

## 3. Target personas
1. Content editor: 10–30 short videos per day, wants speed and manual control.
2. Creative lead: reviews hooks, brand style, CTA, product correctness.
3. Ads/media buyer: needs variants by angle (TOFU/MOFU/BOFU), format and campaign.
4. Admin: manages team rights, assets, compute usage, credits.

## 4. Product differentiation
- Edit plan, not blind edit: prompt -> structured actions -> diff/preview -> apply/undo.
- Hybrid: manual timeline and AI agent operate on the same project schema.
- Brand guardrails: fixed product names, price validity window, restricted claims, CTA presets, safe zones.
- Variants: one master video -> multiple ratios, hooks, CTAs and platform-safe outputs.
- Audit: what AI changed, credit estimate, render job state and version history.

## 5. Reference analysis / tradeoffs
| Pattern | Borrow | Risk / gap to avoid |
|---|---|---|
| Kapwing | browser timeline, subtitles, Smart Cut, shared workspace, brand kit, repurpose | complexity, server processing and collaborative conflicts |
| VEED | AI avatars, AI editing, caption and agent integration ideas, video automation | credit/feature fragmentation, less explainable AI output |
| User screenshot | three-pane projects/editor/copilot, vertical preview, layered timeline | dense text in right pane, weak AI action transparency, few inspectors |

Do not assume any proprietary provider source code or designs can be copied. VEED OpenEdit has a separate license for its renderer binaries; commercial integration requires license review.

## 6. Information architecture
Sidebar: Projects, Editor, Templates, Assets, Components, Presets, AI Skills, Render Queue, Team, Settings.
Editor: project breadcrumbs; preview; media bin/inspector (tabs); tracks Video, B-roll, Text, Subtitle, Audio, Effects; AI Copilot; export dialog.

## 7. Feature prioritization
### P0 / MVP
- Projects CRUD, media upload (browser demo or object storage in product), 9:16 / 1:1 / 16:9 / 3:4 canvas.
- Multitrack data model; clip trim/split/move, text overlay, audio mute/volume, timeline playhead, undo/redo.
- Prompt -> command schema for add text, aspect ratio, color/theme, CTA, selected clip trim, subtitle request; review planned modifications before apply.
- Text preset library: Hook, USP, CTA, Sale, Subtitle with drag/add, safe zones.
- Save/version; deterministic render pipeline and render queue with statuses; downloadable video from server in production.
- Brand kit with fonts/colors/logo and roles Owner/Editor/Reviewer.
### P1 / Beta
- STT word timestamps Indonesian/English, caption style and transcript edit.
- Scene/silence detection, smart reframing, automated B-roll from owned assets.
- Variant generator with queue, 3:4 / 9:16, batch thumbnail, comment at timecode.
- Cost estimate per AI task, user confirmation for billable AI calls, approval workflow.
### P2 / Later
- AI UGC/avatars, text/image-to-video providers, dubbing, voice cloning only with consent.
- Template marketplace, integrations with drives, external stock providers, APIs/webhooks.
- Marketing performance feedback loop (opt-in, clearly attributed, no promises of virality).

## 8. Core AI Copilot contract
Input: user utterance + project_version + selected_clips + source asset references + brand rules.
Process:
1. Parse user intent into *typed edit actions* (JSON schema), validate ranges and permission.
2. Estimate cost/time or mark unavailable capability.
3. Show plan with affected layers, before/after and warnings.
4. User explicitly applies; transaction produces new immutable project revision.
5. Supports undo, reject, selectively accept, redo, activity log.
Example action: `{ "type":"add_text", "startMs":1000, "endMs":4000, "text":"Celana kantor yang effortless", "preset":"hook" }`.
Never grant LLM unrestricted file, database, shell, tool or paid-provider permissions. Must require explicit approval for paid/external and bulk/destructive actions.

## 9. Example workflows
### A: Styling product
Import clips -> prompt “Buat hook 2 detik, tone minimalis, CTA join live di akhir” -> see three proposed text layers -> apply -> adjust timeline -> export 1080x1920.
### B: Talking-head educational
Import 3-minute video -> transcribe -> silence detection -> review cuts -> captions -> add key-word graphics -> render.
### C: Ads creative variants
Start master -> four variant briefs -> different hooks/CTAs -> individual approval -> queue render -> track resulting file assets and usage credits.

## 10. Functional acceptance criteria
- Every AI change maps to schema-validated project edits with undo; no destructive overwrite.
- Timeline and preview read the same state; playhead is deterministic for selected time.
- An upload is displayed with correct intrinsic aspect ratio and duration; incompatible formats produce a useful error.
- Export always reports queued/processing/completed/failed; output resolution/frame rate explicit.
- Captions are editable, timestamped, and checked for overlap/out-of-bounds.
- Roles and audit events are enforced on server, not only UI.
- Brand constraints flag expired prices and unsupported marketing claims before render.

## 11. Architecture recommendation
Frontend: React/Next.js + TypeScript, timeline components, HTML5 video preview/WebGL canvas if needed.
State: normalized Project JSON schema, action reducer, undo history; authoritative version held server-side.
Backend: API + Postgres + object storage/S3 compatible + queue/Redis + workers.
Video: FFmpeg composition/render, subtitles via ASS or canvas compositions, optional Remotion for programmatic motion; GPU services only for AI-intensive tasks.
AI: LLM planner produces validated JSON edit actions; speech-to-text service with word timestamps; background workers; provider adapter for generative services.
Collaboration: optimistic concurrency on project revision, comment events, soft locks for track edits; avoid full multiplayer in MVP.
Security: signed uploads, media file validation, quota control, isolated render workers, restricted tool permissions, retention and deletion controls, licensing and consent policies.
Observability: render job errors, action trace, version diff, AI-token/credit ledger.

## 12. Minimal entities
Workspace, User, Membership, BrandKit, Project, ProjectVersion, Asset, TimelineTrack, Clip, TextLayer, SubtitleCue, AIOperation, Approval, Comment, RenderJob, UsageEvent.

## 13. KPIs and release gates
- Median time to first approved short video.
- Agent edit-plan acceptance rate and number of manual corrections per output.
- Project import success and render completion %, median queue-to-export latency.
- Cost per finished approved video, not just AI credits consumed.
- Brand-policy violation catches, approval turnaround.
Targets must be calibrated during pilot rather than fabricated in PRD.

## 14. Key risks
- Browser decode/export limitations on long 4K sources; use proxy media and server workers.
- Indonesian STT timing, slang, names and brand pronunciation errors; manual review needed.
- Video generation can change garment details; prefer real product footage for commercial listings.
- AI agent hallucinated commands; structured schemas, dry-run plans and revert mandatory.
- Legal IP/licensing for stock, synthetic likeness and voice; document permissions.
- Cloud rendering and inference cost may outstrip subscription pricing; quota and job budgets required.

## 15. Delivery phases
1. Foundation: project/asset schema, upload, preview, basic timeline, manual text layers and JSON save.
2. Agent alpha: typed prompt actions, preview/apply/reject, undo/versioning.
3. Renderer: deterministic server export, render queue, download, monitoring.
4. Creator productivity: subtitle transcription, trim/split, clip intelligence, presets.
5. Team beta: comments, approvals, Brand Kit, roles, usage ledger.
6. Scale: multi-variant batch workflows and generative adapters.

## 16. Prototype scope and limitations
The accompanying HTML is an interactive UX prototype, **not a working AI video engine**. It supports local video upload/browser preview, aspect ratio, text overlays, playhead, action planning for a limited Bahasa Indonesia prompt set, applying/reverting action plans, asset list, mock render flow and project JSON export. It does not perform LLM inference, speech transcription, composited MP4 rendering, server storage, or multi-user collaboration. The mock render must never be mistaken for a generated MP4.


## 17. AI Brain Settings & provider switching (v0.2 addition)
**Goal:** An administrator can switch the command interpretation engine without changing the project/timeline format. Modes: (a) Local Rule/Workflow Engine (no LLM API tokens), (b) Cloud LLM providers through backend adapters (OpenAI, Anthropic, Gemini, OpenRouter, others), (c) Self-hosted models through a server-side endpoint.

### Settings UX
- AI mode and provider picker, model ID, backend endpoint reference, test connection (server only), enabled capabilities, fallback model and per-operation cost estimate.
- Secret entry and masked status, revoke/rotate key, per-provider scopes; **never** store provider secrets in browser/localStorage, client-side bundle, project JSON or analytics events. Server stores encrypted credentials in KMS/secrets vault.
- Controls: max tokens per plan, request timeout, daily/monthly USD budget, allowlist of edit actions, approval required before action application, auto-fallback rules, audit logs.
- Model catalog must be queried from provider adapters, not hardcoded as globally available; unsupported features degrade gracefully.

### Execution path and cost architecture
1. **Zero-LLM path**: buttons, keyboard commands, presets, batch recipes, FFmpeg scripts, template-based captions/text/layout, rule-based prompt patterns. No API token charge, but CPU/GPU and cloud storage/render fees still exist.
2. **One-call planning path**: open-ended language instruction → LLM parses context and generates validated, typed edit actions → local engine applies them deterministically. Token cost arises only when interpreting the prompt (and additional calls if correction needed), not for every frame or every action.
3. **Media AI path**: transcription, speech synthesis, avatar, image/video generation, face-aware cut and generative B-roll may require model inference, credits, per-minute rates, or self-host GPU. Track separately from LLM tokens.

**Provider-neutral planning schema:** `{schema_version, project_revision, operations:[{action, track_id, start_ms, end_ms, params}], rationale, cost_estimate, requires_approval}`. Validate strict JSON schema, allowed operations, ranges, budget, idempotency and revision before apply. AI provider never edits files or database directly.

### Acceptance criteria
- Switching brain does not destroy timeline state or project versions.
- Local mode produces no external model call and supports a documented subset of instructions.
- Cloud model can be selected and tested only via authenticated backend; invalid keys fail safely without saving plaintext.
- A request exceeding budget is blocked before inference when estimable, with hard provider limits where available; metering records actual usage.
- Unsupported instructions are reported, never silently faked or claimed successful.
- Secret rotation and failed provider fallback are traceable.

### Prototype-only disclaimer
Settings modal allows configuration previews, but deliberately does **not** connect provider API keys or persist secrets. Model/provider choices are demo state, while Copilot remains local parser unless and until the secure backend is implemented.


## 18. Kapwing × VEED capability catalog and implementation status (v0.3)
**Important:** A feature named here is not automatically built. Prototype statuses are explicit in the HTML Features catalog: 3 limited working demos (local browser preview/import, ratio, overlay; plus local prompt planning separately) and remaining modules planned. Its availability claims must not be confused with actual Kapwing/VEED parity.

**Editorial foundation (P0):** true multi-clip/multi-track timeline with trim/split, transitions, text/CTA overlays, audio tracks/mixing, preview consistency, save/load, FFmpeg render output, presets and Brand Kit.

**AI & speech (P1):** real model-independent intent planner with structured JSON actions, Indonesian/English STT word timestamps, auto subtitle, scene detection, silence removal, long-to-short AI Clip Maker, reframing, AI B-roll search.

**Generative & team (P2):** AI avatars, UGC ads, text/image-to-video, TTS, dubbing, lip-sync, eye-contact adjustments, shared asset folders, roles, timestamp review comments, approvals, batch creative variations, render queues, licensed stock library, audit/cost reports.

**Settings UX (v0.3):** execution strategy placed entirely under Settings: Auto router (rules first → only call LLM as needed), rules-only, or AI planner. Provider choices include OpenAI, Anthropic, Gemini, OpenRouter, Azure OpenAI, Ollama, LM Studio, and a custom adapter. These are selection slots in the HTML, not working API connectors. A provider adapter must map capabilities, auth scheme, token limits, streaming, tool/JSON support, usage metering, timeout/retry and model compatibility; generative video/transcription providers are separate from LLM planners.

**Production technical acceptance test:** configure two real providers with secrets vaulted on server; switch without breaking project revisions; test connection through backend; ensure unsupported model features are disabled; verify deterministic local path generates zero external LLM calls; cloud path records actual metering; fail safe and give user errors; never expose API keys in browser JS.


## v0.4 — Automatic AI Provider Failover (27 October 2026)

**Status:** UI configuration and offline simulation in HTML. **Not implemented:** provider connections, real health checks, token accounting, routing backend, actual failover, API key storage.

### Requirements
- Settings-only routing configuration: enable failover, ordered primary/backup providers, retry count, default cooldown.
- Accept only authorized official API credentials and/or owned local/self-hosted models. Subscription login credentials (ChatGPT Pro or Gemini app) do not constitute API credits. Do not pool accounts or rotate identities to evade provider quotas, bans, spend caps, or contractual limits.
- Route requests by **capability** (LLM planning, speech-to-text, image/video generation), cost, model availability, quality constraints, and provider entitlement.
- On transient 429 / 503 / network timeout: honor Retry-After, exponential backoff + jitter and circuit breaker; retry safely, then fail over to a separately authorized provider if allowed. Preserve idempotency keys to avoid duplicate paid tasks.
- On insufficient credit, project/organization spend limit, 401/403, or policy denial: **do not** bypass limits by rotating accounts. Mark provider unavailable and require user/admin action; only allow a separately authorized independent provider under its own valid quota and spend budget.
- Never treat accounts/keys in the same provider organization as independent rate limit pools.
- Show explicit active provider, pending queue, cooldown, failover reason, request ID, estimated/actual spend, and no-backend warning in prototype.
- Keep provider secrets encrypted server-side; no browser-side real key transmission or localStorage.
- User-configured hard spending caps; fail closed if exceeded.

### Acceptance tests
1. Primary provider transient timeout: retries with cooldown then routes to healthy backup without modifying the edit plan format.
2. Billing exhausted: no automatic retries against other identities within same provider; provide payment/limits remediation and optionally use an independently authorized alternative vendor.
3. All providers unavailable: queue with clear failure state, never falsely claim edits were completed.
4. Provider returns unsupported capability: route only to a compatible provider; do not silently degrade without approval.
5. Repeated request: no duplicate render or AI generation charges.


## v0.5 — Manual API Enrollment + Automatic Provider Switch

- Semua provider dimasukkan manual oleh administrator melalui Settings > AI Provider Manager. Tidak ada auto-discovery kredensial, login scraping, atau rotasi akun untuk melampaui batas layanan.
- Production: `POST /api/provider-connections` menyimpan API key dalam encrypted secret vault (backend), mengembalikan connection ID serta nama/masked suffix. Frontend tidak menerima key kembali. Hanya admin dapat membuat, menguji, mengaktifkan, menonaktifkan, mencabut, dan menyusun prioritas.
- Setiap koneksi berisi provider, model, kemampuan (planner/transcription/vision/video generation), status test, prioritas, batas biaya, dan allowed tasks. API key yang dicabut segera tidak eligible.
- Router beroperasi hanya pada koneksi resmi dan sesuai kebijakan provider: local rules first; pilih koneksi sehat dan kapabel; fallback lintas provider untuk timeout/5xx, rate limit menurut Retry-After, atau anggaran/kredit yang benar-benar terdeteksi; perhatikan idempotency dan biaya retry. Jangan switch ketika permission error 401/403 tanpa tindakan admin, atau ketika semua provider tidak available.
- Retry tidak boleh menerapkan operasi timeline dua kali. Planner output selalu JSON schema yang divalidasi, melalui preview + approval, lalu local edit engine. Log routing menyimpan timestamp/provider alias/error class/cost tanpa secret atau isi video sensitif.
- Prototype v0.5: antarmuka registrasi koneksi manual hanya dalam memori tab, tanpa penyimpanan key dan tanpa request jaringan. Simulasi failover mensyaratkan sedikitnya dua koneksi demo terdaftar. Produksi backend belum dibangun.

Acceptance tests production: (1) 2 API key valid terdaftar manual, (2) key disensor saat ditampilkan, (3) provider utama timeout -> tugas planner dialihkan satu kali ke backup yang mendukung kemampuan, (4) 429 patuhi Retry-After/aturan layanan, (5) semua koneksi tidak tersedia -> antrekan/error eksplisit, (6) local automation tetap tanpa panggilan LLM, (7) tidak ada secret dalam localStorage, ekspor proyek, log frontend, (8) tidak ada retry yang menduplikasi timeline edit.
