# T01 — Audit Prototype HTML v0.5 FIXED

| Field | Isi |
|---|---|
| Tanggal | 2026-11-03 |
| Status | **TESTING — menunggu sign-off owner** |
| Target | `prototype/prototype_v0.5_FIXED.html` (SHA-256 `206c87a1edbbff1d6f3ccdcf0c9649828b559f519c30dbc581af0103ef9c6484`, identik dengan sumber di `D:\PRD\video\...`) |
| Lingkungan | Windows 11, Node v24.18.0, Google Chrome 156 (headless via `playwright-core@1.49.1`), FFmpeg untuk fixture |
| Cara ulang | `cd audit/T01 && npm install && node audit.mjs` → hasil di `evidence/results.json`, log di `evidence/run_log.txt` |
| Hasil | **34 PASS · 14 FAIL · 1 NOT TESTED** (49 cek) |

## 1. Inspeksi struktur & syntax
- 1 file HTML mandiri (~46 KB): CSS inline, 1 IIFE `'use strict'`, tanpa dependensi eksternal.
- `node --check` atas script yang diekstrak (`evidence/extracted_script.js`): **PASS**.
- Load di Chrome: 0 console error, 0 page error (**A01 PASS**). 0 request jaringan eksternal (**G06 PASS**).
- Semua teks dinamis memakai `textContent` → tidak ditemukan vektor XSS dari input user.
- Pola "monkey-patch" berlapis (`openBrain` dan `brainSave.onclick` dibungkus 2–3 kali, baris 39–41 & 77–78) → rapuh; sumber bug G04b.

## 2. Yang berfungsi (PASS, ringkas)
Rasio canvas 4 opsi · tambah/edit teks & CTA · overlay muncul sesuai waktu · klik linimasa memindah playhead · undo bertahap + undo kosong · Copilot plan → terapkan / tolak · perintah unsupported tidak dipalsukan (tombol Terapkan disabled) · perintah tak dikenal dijawab jujur · play simulasi & video nyata · mute · import MP4 H.264 (durasi terbaca 8 s) · tolak file non-video · proyek baru · export JSON · Render jujur "Belum tersedia" · nav modul rencana jujur · cari proyek · katalog fitur (29 modul: 4 demo, 25 rencana) · failover demo butuh ≥2 koneksi · **API key tidak masuk localStorage/sessionStorage/cookie/DOM/export JSON** · responsif 1100 px & 820 px.

## 3. Temuan (FAIL) — diurut tingkat keparahan

| ID temuan | Tes | Keparahan | Deskripsi | Bukti |
|---|---|---|---|---|
| F-01 | C05-2, C05-3, A02 | **Tinggi** (crash) | Prompt rasio dengan spasi, mis. `1 : 1` / `9 x 16`, diubah jadi `1:::1` / `9:::16`. Saat diterapkan, `render()` melempar `undefined is not iterable`; UI setengah ter-render (select 16:9, state rasio invalid). Penyebab: `replace(/[\sx]/g,':')` mengganti tiap spasi dengan `:`. | run_log, `04_ratio_prompt_probe.png` |
| F-02 | H01 | **Tinggi** (klaim palsu) | Badge "● Disimpan lokal" selalu tampil, padahal tidak ada penyimpanan apa pun; reload = semua edit hilang. Melanggar guardrail "jangan klaim fitur yang tidak ada". | clipsAfterReload=0 |
| F-03 | I06 | Sedang | Import video tidak masuk history. Undo setelah import mengembalikan `duration=30` padahal video 8 s → state & media tidak sinkron. | durationAfterUndo=00:30 |
| F-04 | I02 | Sedang | Teks yang dibuat sebelum import tidak di-clamp ke durasi baru (CTA 25–30 s di video 8 s → `left=312.5%`, tak pernah tampil, tanpa peringatan). | run_log |
| F-05 | I01b | Sedang | Ruler linimasa statis 00:00–00:30 (hardcoded HTML); tidak mengikuti durasi video → posisi playhead menyesatkan. | `07_video_imported.png` |
| F-06 | I10 | Sedang | Tambah teks saat playhead di ujung → clip durasi ~0 (lebar 0,16%), praktis tak terlihat; tidak ada validasi durasi minimum. | run_log |
| F-07 | G05 | Sedang | Mode Cloud: pesan simpan bilang "Copilot masih menggunakan planner lokal", tapi Copilot justru menolak semua perintah ("Backend AI belum terhubung"). Pesan & perilaku bertentangan. | run_log |
| F-08 | G04b | Rendah | Klik **Batal** di Settings tidak me-reset field Strategi Eksekusi; dibuka lagi menampilkan nilai yang belum disimpan. Wrapper `openBrain` baris 77 tidak pernah terpasang ke tombol Settings (binding sudah terjadi di baris 41). | run_log |
| F-09 | J-390 | Rendah | Lebar 390 px (HP): scroll horizontal (scrollWidth 622). Grid kolom min 330 px + 55 px rail. | `08_responsive_390.png` |
| F-10 | F01 | Rendah (a11y) | Escape tidak menutup modal; tidak ada focus trap. | run_log |
| F-11 | F03, F04 | Rendah (UI dummy) | Tombol nav "Proyek" dan item proyek di sidebar tidak punya aksi; folder (15/19) dan daftar proyek adalah data contoh statis. | run_log |

**NOT TESTED** — I03 (PRD §10: video tampil dengan aspek intrinsik). Prototype selalu `object-fit:cover` ke rasio canvas; tidak ada deteksi/penanganan rasio intrinsik. Ini gap desain, bukan bug yang bisa diuji di prototype.

Catatan tambahan (bukan FAIL): I09 — undo "Proyek baru" mengembalikan nama & teks tapi **tidak** video (URL sudah di-revoke). State tetap konsisten (tanpa video), tapi user kehilangan media tanpa peringatan.

## 4. Gap prototype vs PRD (bukan bug, tapi jangan dianggap fitur)
- Tidak ada: persistensi proyek, multi-clip, trim/split/move, audio track, subtitle, render MP4, backend AI/provider, storage/GC (ST-01..ST-10), roles, brand kit nyata.
- Undo hanya snapshot teks/rasio/durasi; media tidak masuk history.
- Ini konsisten dengan PRD §16 (prototype UX, bukan engine).

## 5. Rekomendasi untuk T02
Prototype ini **referensi UI**, target final desktop/hybrid. Memperbaiki semua temuan di HTML = kerja yang nanti dibuang. Usulan: perbaiki hanya F-01 (crash) dan F-02 (klaim palsu) di prototype; F-03..F-11 dicatat sebagai **requirement/test case** untuk implementasi nyata. Keputusan di tangan owner.

## 6. Format laporan wajib (PRD §D)
`T01 | Audit HTML v0.5 FIXED | TESTING (menunggu sign-off) | prototype/prototype_v0.5_FIXED.html, audit/T01/* | 34 PASS / 14 FAIL / 1 NOT TESTED, bukti evidence/ | F-01..F-11 | belum (menunggu keputusan T02) | T02 | commit: belum tersedia (repo belum dibuat, T04)`
