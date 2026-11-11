# Audit kesesuaian dengan PRD — Motion Studio (2026-11-11)

**Pertanyaan owner:** "motion yang lo buat kok jauh dari PRD?"

**Dasar audit:** `docs/PRD_MASTER_v1.0.md` (§0.1, checklist E, §4, §6–§10, §17, v0.4–v0.5, v0.8) dibandingkan dengan kode di commit `90c33e7`. Laporan ini hanya berisi pemetaan dan belum mengubah kode apa pun.

**Jawaban singkat: ya, cukup jauh di sisi fitur editor kreatif.** Yang sudah dibangun kuat di fondasi:
- penyimpanan + Smart GC;
- keamanan;
- render nyata;
- Copilot "rencana → setujui → undo";
- AI provider + anggaran;
- transkrip;
- deploy.

Yang sudah dibangun sudah diuji dan diaudit. Masalahnya ada pada hal yang belum dibangun: banyak fitur **P0/MVP yang membuat app terasa seperti editor video** belum ada, misalnya preset & gaya teks, Brand Kit, volume audio, inspector klip, dan peran tim.

## Kenapa bisa terjadi
1. **Urutan kerja yang disetujui tidak sama dengan checklist PRD.**
   - PRD §E: T02–T15 = skema → editor → preview → save/load → render → Copilot → AI → STT → **T15 scene detection/silence removal**.
   - Urutan yang dijalankan: rencana v1.0 (storage/Smart GC, 15 task), lalu rencana v2.0 (web app, login, render, AI, deploy).
   - Fitur kreatif P0 (preset teks, Brand Kit, audio, peran) **tidak pernah masuk ke rencana mana pun**.
   - T15 PRD (silence removal) juga tidak terjadwal: slot W15 dipakai untuk paket deploy.
2. **Pivot owner yang disengaja** mengubah arsitektur. Ini bukan kesalahan, tapi menambah pekerjaan infrastruktur:
   - desktop → web (PC-5);
   - Google Drive lalu batal (PC-13);
   - VPS hanya pintu (PC-14).
3. Setiap task diaudit terhadap *rencana task-nya sendiri*, bukan terhadap daftar P0 PRD secara keseluruhan. Gap ini baru terlihat sekarang.

## Peta status
Status: ✅ ada & diuji · 🟡 sebagian · ❌ belum ada · ⏸ diubah oleh keputusan owner

### P0 / MVP (PRD §7)
| Requirement | Status | Catatan |
|---|---|---|
| Projects CRUD | 🟡 | Buat, daftar, buka ✅. **Ganti nama, duplikat, hapus/arsip proyek, ekspor/impor JSON ❌** (prototype punya "↓ JSON"). |
| Upload media, 4 rasio canvas | ✅ | Upload + probe durasi/rasio asli; 9:16, 1:1, 16:9, 3:4. |
| Multitrack + trim/split/move + playhead + undo/redo | ✅ | Server-side, satu reducer untuk manual & Copilot. |
| Text overlay | 🟡 | Teks hanya **isi + waktu**. **Tidak ada posisi, font, ukuran, warna, latar, animasi**; render memakai satu gaya tetap. |
| **Audio mute/volume** | ❌ | Tidak ada op volume/mute; render mencampur semua audio apa adanya. |
| Prompt → perintah: tambah teks, rasio, CTA, trim klip terpilih, subtitle | ✅ | Planner lokal + AI. Semua lewat review sebelum diterapkan. |
| Prompt: **warna/tema** | ❌ | Belum ada karena teks belum punya gaya. |
| **Preset teks Hook / USP / CTA / Sale / Subtitle** (drag/add, safe zone) | ❌ / 🟡 | Hook/CTA hanya *penempatan waktu* lewat Copilot; tidak ada perpustakaan preset bergaya. Safe zone ✅ di pratinjau. |
| Save/versi, render deterministik, antrean + status, unduh | ✅ | Revisi + undo 50 langkah; MP4 FFmpeg + metadata dibersihkan + verifikasi. |
| **Brand Kit (font/warna/logo)** | ❌ | — |
| **Peran Owner / Editor / Reviewer** | ❌ | Hanya allowlist email; semua yang login setara admin. |

### P1 / Beta
| Requirement | Status | Catatan |
|---|---|---|
| STT word timestamps ID/EN + edit transkrip | ✅ | Lewat provider resmi + anggaran; cue tervalidasi. |
| **Gaya caption** | ❌ | Subtitle satu gaya tetap. |
| **Scene/silence detection, review cuts** (PRD T15) | ❌ | Bisa zero-LLM dengan FFmpeg `silencedetect`/`scdet`. |
| Smart reframing, auto B-roll dari aset sendiri | ❌ | — |
| **Variant generator** (rasio/hook/CTA), batch thumbnail | ❌ | Workflow C PRD belum bisa dijalankan. |
| Komentar di timecode, approval workflow | ❌ | — |
| Estimasi biaya per tugas AI + konfirmasi panggilan berbayar | ✅ | Planner: biaya per rencana. STT: konfirmasi harus persis. |

### Kontrak Copilot (PRD §8, §17)
| Requirement | Status |
|---|---|
| Aksi bertipe JSON tervalidasi, cek rentang & izin | ✅ |
| Estimasi biaya / tandai kemampuan tak tersedia | ✅ |
| Rencana + lapisan terdampak + before/after + peringatan | ✅ (diff per operasi yang dicentang) |
| Apply eksplisit → revisi baru; undo, tolak, setujui sebagian, redo, log | ✅ |
| Input **brand rules** | ❌ (Brand Kit belum ada) |
| Mode lokal / otomatis / AI; lokal tanpa panggilan eksternal | ✅ |
| Katalog model dari provider | 🟡 (tes koneksi membaca daftar model, tapi model diketik manual) |
| **Allowlist aksi edit** di pengaturan | ❌ |
| Failover resmi, Retry-After, anggaran keras, secret terenkripsi | ✅ (diaudit Checkpoint F) |
| Contoh Workflow A ("Buat hook 2 detik, tone minimalis, CTA join live di akhir" → 3 layer teks) | 🟡 Mode AI bisa; mode lokal butuh teks dalam tanda kutip dan tidak mengarang copy. |

### Kriteria penerimaan (PRD §10)
| Kriteria | Status |
|---|---|
| Setiap perubahan AI = edit tervalidasi + undo, tanpa overwrite destruktif | ✅ |
| Timeline & preview membaca state yang sama; playhead deterministik | ✅ |
| Rasio & durasi asli upload benar; format tak cocok → error berguna | ✅ |
| Ekspor melaporkan antre/proses/selesai/gagal; resolusi & fps eksplisit | ✅ |
| Caption bisa diedit, bertimestamp, dicek tumpang tindih/di luar durasi | ✅ |
| **Peran & audit ditegakkan di server** | 🟡 Audit ✅; peran ❌ |
| **Brand constraint: tandai harga kedaluwarsa & klaim terlarang sebelum render** | ❌ |

### Arsitektur informasi (PRD §6)
| Bagian | Status |
|---|---|
| Sidebar: Projects, Editor, Assets (Media), Settings (AI) | ✅ |
| Sidebar: **Templates, Components, Presets, AI Skills, Render Queue (global), Team** | ❌ |
| Editor: preview, media bin, track Video/B-roll/Teks/Subtitle/Audio/**Effects**, Copilot, dialog ekspor | ✅ (track Effects ada tapi **belum ada efek/transisi**) |
| Editor: **inspector klip (tab properti)**, breadcrumb proyek | ❌ |

### Berubah karena keputusan owner (bukan gap)
| PRD | Sekarang | Keputusan |
|---|---|---|
| Desktop/hybrid local-first | Web app; server di PC owner; VPS hanya pintu | PC-5, PC-14 |
| Google Drive | Dibatalkan; file tetap di disk server | PC-13 |
| Postgres + S3 + Redis + worker | File JSON + disk lokal + job di memori (cukup untuk 1 tim) | ADR-001/002 |
| Next.js | React + Vite | teknis, setara |

### Yang sudah melebihi / sesuai PRD
Fondasi PRD v0.8 lengkap:
- Smart GC;
- Trash;
- purge manual dengan frasa;
- proteksi media.

Lalu:
- metadata render dibersihkan (aturan owner);
- login + allowlist;
- AI failover / anggaran (v0.4–v0.5);
- paket deploy;
- 6 checkpoint audit.

## Rekomendasi: rencana v3 "Paritas P0 PRD"
Urutan usulan, 5 task per checkpoint seperti biasa.

| ID | Task | Kenapa duluan |
|---|---|---|
| X01 | **Gaya teks di skema** (posisi, font, ukuran, warna, latar, perataan) + render & pratinjau identik | Fondasi semua preset/Brand Kit |
| X02 | **Inspector klip** (panel properti: waktu, teks, gaya, volume) | Cara manual mengubah gaya |
| X03 | **Preset teks Hook / USP / CTA / Sale / Subtitle** + Copilot "tone/warna" | P0 + contoh Workflow A PRD |
| X04 | **Audio: volume & mute per klip/track** (pratinjau + render) | P0 |
| X05 | **Kelola proyek:** ganti nama, duplikat, arsip, ekspor/impor JSON | P0 CRUD |
| CHECKPOINT G | | |
| X06 | **Brand Kit** (font, warna, logo) → dipakai preset & Copilot | P0 |
| X07 | **Deteksi hening & adegan → review potongan** (FFmpeg, tanpa LLM) | PRD T15 / Workflow B |
| X08 | **Brand guard** sebelum render (harga kedaluwarsa, daftar klaim terlarang) | Kriteria §10 |
| X09 | **Varian** (rasio / hook / CTA → antrean render) | Workflow C |
| X10 | **Peran Owner / Editor / Reviewer + komentar di timecode + approval** | P0 peran + P1 tim |
| CHECKPOINT H | | |

Ditunda (P1 lanjut/P2): reframing otomatis, auto B-roll, template marketplace, avatar/TTS/dubbing, transisi/efek lanjutan.

Keputusan owner: **PC-15** di `PROGRESS.md`.
