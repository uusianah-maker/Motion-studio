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
- [ ] X10 **Peran Owner / Editor / Reviewer** + komentar di timecode + approval.

**CHECKPOINT H**

## Ditunda
- Reframing otomatis, auto B-roll.
- Transisi/efek lanjutan.
- Template marketplace, avatar/TTS/dubbing (P2).
- Deploy nyata (menunggu owner).
