# IMPLEMENTATION PLAN v3.0 — Paritas P0 PRD (fitur editor kreatif)

**Status:** dijalankan lewat `/gasngoding` (2026-11-11). PC-15 dianggap **A** (P0 dulu, deploy setelah X05), karena deploy memang menunggu langkah owner (domain, VPS, OAuth). Owner bisa mengubah urutan kapan saja.

**Dasar:** `audit/PRD_GAP_AUDIT.md` (gap P0/P1 terhadap `docs/PRD_MASTER_v1.0.md` §7, §8, §10).

Aturan tetap:
- satu task aktif;
- tes otomatis per task (core + server + UI Chrome);
- checkpoint audit independen tiap 5 task;
- tidak ada push/deploy tanpa izin owner.

## Fase A — P0 inti
- [x] X01 **Gaya teks** di skema: posisi (pusat x/y), ukuran (% sisi pendek), lebar baris, warna, kotak latar + opasitas, tebal, outline, perataan. Op `set_style` (+ `style` di `add_clip`), ikut undo; split mempertahankan teks + gaya. Pratinjau dan render memakai fungsi layout yang sama (`textStyle.ts`).
  - *Selesai 2026-11-11.* Tes:
    - core: render nyata, posisi kotak dicek per piksel;
    - UI Chrome 9/9: posisi/ukuran/warna/baris pratinjau = gaya, desktop + HP.
- [x] X02 **Inspector klip:** panel properti klip terpilih (waktu, teks, gaya: posisi drag, ukuran, warna, kotak, perataan; volume untuk klip media setelah X04). *Selesai 2026-11-11: inspector + seret teks di pratinjau; UI Chrome 11/11.*
- [x] X03 **Preset teks Hook / USP / CTA / Sale / Subtitle** (perpustakaan + tambah ke playhead) dan Copilot "tone/warna" (mis. `warna teks merah`, `pakai preset sale`). *Selesai 2026-11-11: perpustakaan preset + preset di inspector + Copilot warna/kotak/preset/tone/posisi/ukuran; UI Chrome 11/11.*
- [x] X04 **Audio:** volume & mute per klip/track (pratinjau + render). *Selesai 2026-11-11: volume klip (inspector + Copilot), mute track (label linimasa), pratinjau & render ikut; render nyata diukur volumedetect; UI Chrome 12/12.*
- [x] X05 **Kelola proyek:** ganti nama, duplikat, arsipkan, ekspor/impor JSON proyek. *Selesai 2026-11-11: menu ⋯ Proyek (nama, duplikat, arsip hanya-baca, ekspor .json) + impor .json di daftar proyek; media dicocokkan via id atau hash; UI Chrome 12/12.*

**CHECKPOINT G** — *lulus 2026-11-11 setelah perbaikan (0 High, 1 Medium, 5 Low; `audit/CHECKPOINT_G/`).*

## Fase B — P0 sisa + P1 kunci
- [x] X06 **Brand Kit** (font, warna, logo) dipakai preset & Copilot. *Selesai 2026-11-12: halaman Brand (warna, warna teks, font .ttf/.otf, logo + posisi/ukuran/opasitas), preset Brand, swatch + Font di inspector, saklar Logo per proyek, Copilot "pakai brand / warna brand / font brand / tampilkan logo"; pratinjau = render; UI Chrome 13/13.*
- [x] X07 **Deteksi hening & adegan → review potongan** (FFmpeg, tanpa LLM), sesuai PRD T15. *Selesai 2026-11-13: tombol "✂ Deteksi jeda & adegan" di inspector klip media → centang jeda/adegan → rencana + diff → Terapkan (satu undo); jeda dihapus di semua track (subtitle tetap sinkron); UI Chrome 13/13.*
- [x] X08 **Brand guard** sebelum render: harga kedaluwarsa dan daftar klaim terlarang. *Selesai 2026-11-13: aturan di Brand Kit (harga promo + tanggal berlaku, klaim terlarang, level blokir/peringatan); dialog render menampilkan masalah per klip & waktu; merah = render diblokir, kuning = harus dicentang "render tetap" (tercatat di audit); Copilot menolak menulis klaim/harga terlarang; UI Chrome 9/9.*
- [x] X09 **Varian:** rasio / hook / CTA → antrean render. *Selesai 2026-11-13: tombol "◫ Varian" di master → brief (rasio/hook/CTA) → tiap varian proyek sendiri (V1, V2, …), master tidak berubah → setujui satu per satu (persetujuan terikat revisi) → "Render yang disetujui" mengantrekan render; status & file per varian; UI Chrome 13/13.*
- [ ] X10 **Peran Owner / Editor / Reviewer** + komentar di timecode + approval. *→ dipindah ke U7 (PC-16).*

**CHECKPOINT H**

## Fase C — Satu aplikasi tanpa Remotion (PC-16, keputusan owner 2026-11-13)
Kontrak dengan mesin: `D:\VIBECODING\remotion\docs\KONTRAK-ENGINE.md` v0.3. Isian brand: `D:\VIBECODING\remotion\docs\BRAND-KIT-LENGKAP.md`.
- [x] U1 **Brand Kit multi-brand** + isian A–F + brand per proyek + ekspor `brand_kit.json` (kontrak bagian 4). *Selesai 2026-11-13: brand banyak (kode unik, bawaan ★), isian A–F lengkap (E menyusul U2), font judul + caption, logo terang, penutup, brand dipilih per proyek (render, Brand guard, Copilot ikut brand proyek), ekspor `brand-kit-export/1` (`docs/BRAND_KIT_EXPORT.md`), migrasi otomatis Brand Kit lama; UI Chrome 12/12.*
- [x] U2 **Library aset per brand** (SFX, musik, b-roll, logo, penutup) dengan tag & status lisensi. *Selesai 2026-11-13: library di bagian E halaman Brand (unggah banyak, saring jenis/tag, tag saran, lisensi + bukti + boleh-iklan, musik mood/BPM/instrumental, b-roll produk/varian/teks bawaan), SFX dilarang, video referensi; ekspor aset dengan durasi/orientasi dari file; UI Chrome 9/9.*
- [x] U3 **Render pengganti Remotion** (FFmpeg + libass): caption per kata (pop + sorot kata kunci), judul kotak kaca, zoom / punch-in, zoom-through, penutup, disclaimer, −14 LUFS, track `sfx`, `Clip.blur` / `Clip.crop`. *Selesai 2026-11-13 (U3a–U3d): track SFX + Musik, loudness dua lintasan; caption per kata libass (pop/fade, sorot warna/ukuran/kotak); kotak kaca (`bg_blur`); track Efek zoom cut/halus + zoom-through (kurva sama di pratinjau & render); `Clip.crop` + `Clip.blur` (waktu sumber) untuk Batch Remix; preset teks Disclaimer; penutup = klip b-roll (kontrak §8); UI Chrome U3 21/21.*
- [x] U4 **Halaman Generate Otomatis** (upload + brief → mesin → kartu rencana → setujui → render → QC). *Selesai 2026-11-13: menu ⚡ Generate; brand + proyek baru/lama + video + brief (produk/varian dari Brand Kit, harga, placement, preset, catatan, AI opsional); progres per tahap; kartu "Rencana edit siap, render ditahan" (hook, durasi, dibuang, audio, kata kunci, peringatan/kata ragu, daftar operasi); setujui = satu langkah undo; render & QC di Editor; riwayat job; UI Chrome U4 18/18 (bersama U5).*
- [x] U5 **Halaman Batch Remix** (tabel rencana → coret / setujui → antrean render). *Selesai 2026-11-13: menu ▦ Batch; nama batch, jumlah, tujuan, preset, akun sendiri, hak pakai; tabel varian (hook, VO, shot, musik, durasi, QC, tanda UJI untuk musik tanpa lisensi); setujui/coret sekali simpan → varian disetujui jadi proyek varian X09 yang sudah disetujui; render hanya yang disetujui (render nyata dengan crop/blur di UI test).*
- [x] U6 **Runner job** (panggil CLI mesin, `06_ENGINE/<job_id>`, lease sumber, placeholder → MediaRef, progres). *Selesai 2026-11-13: `MOTION_ENGINE_ROOT`; job id `KODE-YYYYMMDD-NNN`; job.json + brand_kit.json (path lokal) + refs.json; lease `engine` selama mesin jalan; JSON-lines progres; kode keluar 0/2/1, batas waktu + hentikan pohon proses; placeholder → MediaRef (sumber, aset brand, `aset_lokal`, footage batch → media bersama), placeholder asing & path di luar folder mesin ditolak; rencana masuk jalur Copilot sumber `engine`.*
- [x] U7 **Peran Owner / Editor / Reviewer + komentar di timecode + persetujuan** (dulu X10). *Selesai 2026-11-13: peran dari `MOTION_OWNER_EMAILS` / `MOTION_EDITOR_EMAILS` / `MOTION_REVIEWER_EMAILS` (login Google), ditegakkan server per rute; panel Review di Editor (komentar di playhead, klik = lompat, selesai/buka; Lulus/Revisi terikat revisi); reviewer hanya-baca, editor tidak bisa menyetujui, Brand Kit & AI khusus Owner; UI Chrome 14/14.*
- [x] U8 **Batch Remix library** (audit yuki 14 Nov, owner "Gas, lanjut"): Upload + Pisah Audio dari dashboard (`engine pisah`), dropdown batch (`engine daftar_batch`), field batch `vo_batch` / `buang_otomatis` / `batas_durasi` / musik uji, rincian kalimat VO → shot per varian, halaman Shot Library + pengecualian shot (disimpan di app, dikirim sebagai `kecualikan_shot`). *Kontrak mesin §9 v0.3.2.*

**CHECKPOINT H** setelah U1–U5; **CHECKPOINT I** setelah U6–U7.

## Ditunda
- Reframing otomatis, auto B-roll.
- Transisi/efek lanjutan.
- Template marketplace, avatar/TTS/dubbing (P2).
- Deploy nyata (menunggu owner).
