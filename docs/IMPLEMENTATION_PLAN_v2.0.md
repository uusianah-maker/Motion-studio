# IMPLEMENTATION PLAN v2.0 — web app + Google Drive (urutan B: UI dulu, Drive menyusul)
Status: **DISETUJUI OWNER 2026-11-04 (PC-8: B)** — "Gas jalankan Point B". Dasar: ADR-002. v1.0 (T01–T15 storage core) selesai dan dipakai ulang.

Aturan tetap: satu task aktif; tiap task diuji; checkpoint audit (reviewer independen) tiap 5 task; tidak ada push/deploy tanpa izin owner.

Alasan urutan B: owner bisa mencoba app dan memberi masukan UI/UX secepatnya; setup Google Cloud (manual oleh owner) tidak memblokir. Risiko integrasi Drive ditekan oleh antarmuka `StorageBackend` (W02) — UI dan server tidak tahu file ada di disk atau di Drive.

## Fase 1 — Fondasi lokal + UI (tanpa Google)
- [x] W01 Restrukturisasi repo: `packages/core` (storage yang ada); `apps/server` (W03) dan `apps/web` (W05) dibuat oleh task-nya; skrip root (`verify`, `test:e2e`, `test:prototype`) tetap jalan; 133 pass / 1 skip, E2E 18/18, prototype 56/56. *Bukan npm workspaces: D: exFAT tidak bisa symlink → satu paket + TS project references.*
- [x] W02 Antarmuka `StorageBackend` di core; backend `LocalFs` = perilaku sekarang (semua tes lama lulus tanpa diubah maknanya). Metadata tetap lokal; byte media/Trash/output lewat backend. Tes kontrak `backendContract()` dipakai ulang untuk backend Drive di W10.
- [x] W03 Server API dasar (Node/TS): hanya listen di 127.0.0.1, health, sesi lokal (token acak per start, belum Google), error bertipe, aktor ditegakkan di server (browser tidak bisa mengaku "user" untuk aksi AI/scheduler).
- [x] W04 Endpoint proyek & media (backend lokal): buat/buka proyek, import file (upload dari browser), daftar media, Trash/restore/purge manual (token + frasa), dashboard storage.
- [x] W05 UI web dari prototype (React): daftar proyek, media library, layout editor, Trash/purge/restore, dashboard storage.
**CHECKPOINT D** — LULUS setelah perbaikan (2026-11-08, `audit/CHECKPOINT_D/CHECKPOINT_D_REPORT.md`)

## Fase 2 — Editor + sambung Google Drive
- [x] W06 Editor timeline inti: pilih, geser, trim, split, undo/redo di atas skema proyek.
- [x] W07 Preview: playhead sinkron teks/video/audio, rasio & safe area, durasi asli (ffprobe), streaming Range lewat URL bertanda tangan. *Proxy resolusi rendah belum dibuat: file asli lokal diputar langsung (Range); cache lokal wajib saat backend Drive (W10).*
- [x] W08 Render MP4 nyata (FFmpeg lokal): preflight + lease (T15), status job, output versioned di 05_OUTPUT. **Wajib (owner 2026-11-08): metadata hasil render dibersihkan sebelum output dinyatakan jadi** — FFmpeg `-map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact` + kosongkan `handler_name`/`encoder` stream; lalu `ffprobe` memverifikasi tidak ada tag tersisa (selain yang wajib secara teknis, mis. bahasa `und`). Gagal verifikasi = render gagal, bukan output kotor. File asli (import) tidak pernah diubah. *Selesai 2026-11-08: FFmpeg ≥7 (dicek), SEI x264 dibuang (`filter_units=remove_types=6`), verifikasi = ffprobe allowlist tag teknis + scan byte (jejak encoder + nilai metadata file sumber). Job render di memori server (antre satu per satu); lease render yang workernya mati dilepas saat server start.*
- [x] W09 Login Google (OAuth "External", scope ~~`openid email profile drive.file`~~ → `openid email profile` sejak PC-13) + allowlist email + token terenkripsi di server. *Uji nyata butuh OAuth Client ID dari owner (langkah manual, dipandu).* *Selesai 2026-11-08 (kode + tes dengan Google tiruan): authorization code + PKCE oleh server, sesi cookie HttpOnly + header wajib; konfigurasi setengah = server menolak start. Sejak PC-13 (2026-11-09) hanya sign-in: tidak ada token Google yang disimpan. Uji nyata menunggu PC-12 (`docs/SETUP_GOOGLE_LOGIN.md`).*
- [~] ~~W10 Backend `GoogleDrive`~~ — **DIBATALKAN (PC-13, owner 2026-11-09): file tetap lokal di disk server; app diakses online.** Rincian lama: owner memilih folder workspace via Google Picker sekali; layout folder, upload/download stream, `.trash` milik app, purge manual, checksum Drive; import via Picker; hasil render di-upload ke Drive. Diuji dengan Drive tiruan + uji nyata ke folder owner.
**CHECKPOINT E** — dipindah ke setelah W11 (5 task: W06–W09 + W11) karena W10 batal. LULUS setelah perbaikan (2026-11-09, `audit/CHECKPOINT_E/CHECKPOINT_E_REPORT.md`)

## Fase 3 — Copilot & AI
- [x] W11 Copilot planner lokal → edit plan JSON tervalidasi → diff → setujui → terapkan → undo. *Selesai 2026-11-09: mesin aturan lokal (tanpa LLM), skema `EditPlan` v1, setujui sebagian, idempotent, satu langkah undo; hook AiPlanner untuk W12.*
- [x] W12 AI Provider Manager (API key manual, rahasia di server) + router & failover resmi. *Selesai 2026-11-09: Anthropic/OpenAI/Gemini/kompatibel-OpenAI lewat HTTP resmi, key disegel, failover hanya lintas provider; diuji dengan provider tiruan.*
- [x] W13 Usage/biaya, batas anggaran keras, audit. *Selesai 2026-11-09: reservasi perkiraan terhadap batas per permintaan/harian/bulanan sebelum kirim, biaya nyata dari usage provider ke buku pemakaian.*
- [x] W14 Caption/STT + edit transkrip. *Selesai 2026-11-09: STT word timestamps lewat router AI + anggaran (biaya dikonfirmasi dulu, audio tanpa metadata), edit cue tervalidasi, subtitle lewat rencana + satu undo.*
- [x] W15 Uji E2E UI (Playwright) + paket deploy VPS (deploy nyata menunggu izin owner). *Selesai 2026-11-09: E2E online lewat HTTPS + proxy (16/16); paket `deploy/` sesuai PC-14 (VPS = pintu Caddy + SSH reverse tunnel, file & render tetap di PC owner); `npm run check:deploy`.*
**CHECKPOINT F** — LULUS setelah perbaikan (2026-11-09, `audit/CHECKPOINT_F/CHECKPOINT_F_REPORT.md`)

## Catatan Drive owner
- Folder workspace yang disiapkan owner: "video motion folder" (`1pls4-EtmxPa09oxctKgaTx352OOMqWnF`, My Drive, kosong per 2026-11-04).
- Dengan `drive.file`, app hanya bisa memakai folder ini setelah owner memilihnya lewat Picker (W10); perilaku listing isi folder yang dipilih wajib diverifikasi di W10.

## Ditunda (keputusan owner)
- Sewa VPS & deploy online: setelah Fase 2 (UI/UX + frontend + backend) jadi.
