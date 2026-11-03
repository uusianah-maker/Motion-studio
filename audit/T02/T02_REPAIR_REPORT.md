# T02 — Perbaikan temuan T01

| Field | Isi |
|---|---|
| Tanggal | 2026-11-03 |
| Status | DONE |
| File | `prototype/prototype_v0.5_FIXED.html`, `audit/T01/audit.mjs` (suite regresi) |
| Cara ulang | `EVIDENCE_DIR=audit/T02/evidence npm run test:prototype` |
| Hasil | **56 PASS / 0 FAIL** (T01: 34/14/1). `node --check` script: OK |

| Temuan | Perbaikan | Tes regresi |
|---|---|---|
| F-01 crash rasio berspasi | Parser rasio pakai grup tangkap `(16|9|3|1)\s*[:x×]\s*(16|9|4|1)`, hanya rasio yang dikenal; `render()` fallback ke 9:16 kalau state rasio invalid | C05-1..3, A02 |
| F-02 badge palsu | Badge jadi "○ Belum disimpan · prototype" + tooltip; tidak pernah berubah jadi "Disimpan" | H01 |
| F-03 undo setelah import | Undo tidak menimpa durasi kalau video sedang dimuat; teks di-clamp ulang | I06 |
| F-04 teks di luar durasi | `clampTexts()` saat metadata video dimuat + pesan Copilot jumlah lapisan yang digeser | I02 |
| F-05 ruler statis | Ruler dibuat ulang di `render()` dari durasi; jumlah label ≤ durasi (tanpa label dobel) | I01b, I01c |
| F-06 teks durasi ~0 | `fitRange()` menjamin durasi minimum 1 s (geser ke belakang bila playhead di ujung) | I10 |
| F-07 pesan mode Cloud | Pesan simpan sekarang bilang Copilot TIDAK memproses perintah sampai backend tersambung | G05 |
| F-08 Batal di Settings | Tombol Settings memanggil `openBrain` terbaru (bukan referensi lama), jadi form di-reset ke nilai tersimpan | G04, G04b |
| F-09 layar 390 px | Media query HP (ditaruh setelah aturan 900 px): grid `48px minmax(0,1fr)`, top bar wrap | J-390, J-390b |
| F-10 a11y modal | Escape menutup modal (Settings ikut membersihkan field key), fokus otomatis ke modal, Tab terkunci di modal, fokus dikembalikan | F01, F01b |
| F-11 klik mati | Nav "Proyek" memfokuskan pencarian; item proyek/folder contoh memberi modal jujur "Data contoh" (+ keyboard) | F03, F04 |
| I03 rasio intrinsik | `object-fit: contain` (letterbox) + resolusi sumber di meta | I03, I03b |

**Regresi yang ketemu & diperbaiki saat T02:**
- Media query HP awalnya kalah oleh aturan 900 px → tombol JSON/Render tersembunyi. Ditambah tes J-*b.
- Background hitam `<video>` menutupi placeholder → `video:not([src]){display:none}`. Ditambah tes A04.

**Tidak diubah (sengaja):** perilaku inti tetap prototype; tidak ada penyimpanan proyek (autosave masih keputusan owner, PRD v0.8 §L).
