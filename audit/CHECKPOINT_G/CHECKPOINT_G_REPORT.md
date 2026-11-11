# Checkpoint G — audit X01–X05 (paritas P0 PRD, plan v3.0)

Tanggal: 2026-11-11 · Status: **LULUS setelah perbaikan**

## Cakupan
- X01 gaya teks · X02 inspector + seret teks · X03 preset teks + Copilot gaya · X04 volume & mute audio · X05 kelola proyek (ganti nama, duplikat, arsip, ekspor/impor JSON).
- Diff yang diaudit: `5e08003^..` ditambah working tree (X05 sebelum commit).

## Review independen
Subagent read-only. Ia hanya diberi PRD, daftar task, dan diff; kesimpulan pelaksana tidak diberikan, dan ia tidak menjalankan tes.

Hasil: **0 High, 1 Medium, 5 Low.** Semua diperbaiki.

| ID | Sev | Temuan | Perbaikan | Bukti |
|---|---|---|---|---|
| G-1 | Medium | Ganti nama/arsip gagal (`INTEGRITY`) kalau satu file media proyek rusak/berubah, padahal linimasa tidak berubah. Proyek rusak jadi tidak bisa diarsipkan. | `commitProject`: kalau linimasa live identik dengan sebelumnya, referensi cukup harus *dikenal* (sama seperti riwayat, PC-10). Edit linimasa dan duplikat tetap menuntut media utuh. | `checkpointG-regressions` G-1 |
| G-2 | Low/Med | Impor mempertahankan id versi yang ada di sini walau versi itu di Trash/rusak, padahal ada salinan aktif dengan isi (hash) sama. | Id hanya dipertahankan bila versinya aktif + utuh; kalau tidak, dicocokkan lewat hash. | G-2 |
| G-3 | Low | Pembersihan saat duplikat/impor gagal hanya jalan bila proyek masih revisi 0. Kalau manifest sudah tertulis lalu langkah berikutnya gagal, folder tertinggal. | Folder yang baru dibuat oleh panggilan itu (id baru, acak) selalu dihapus bila commit gagal. | Kasus Trash di `x05-project-admin` (tidak ada folder tersisa). Kegagalan sesudah manifest tertulis tidak bisa disimulasikan tanpa mock fs → dicek lewat review kode. |
| G-4 | Low | Kata warna Copilot membaca kunci warisan objek (`constructor`, `__proto__`), sehingga pesan error membingungkan. Tidak ada data rusak tersimpan. | `Object.hasOwn` pada tabel warna. | G-4 |
| G-5 | Low | Proyek arsip hanya-baca di server, tetapi UI masih mengaktifkan kontrol edit (tiap klik berakhir error). | Editor: preset, tambah media/teks, undo/redo, split, hapus, seret, rasio, Copilot dimatikan. Inspector dikunci (fieldset disabled). Shortcut edit diabaikan (Spasi tetap putar). | UI `X5-07` |
| G-6 | Low | Tes duplikat "proyek tidak ada" hanya `not.toBe('OK')`, sehingga tidak bisa gagal. | Kini menuntut kode persis `NOT_FOUND`. | `x05-project-admin` |

Area yang dinyatakan bersih oleh reviewer (dicek di kode):
- Injeksi filter graph FFmpeg: warna hex, angka terbatas, teks via file `expansion=none`, `volume` `toFixed(2)`.
- Edge case volume/mute.
- Semua jalur edit (route edit, undo/redo, Copilot apply) lewat `editTimeline` → arsip tidak bisa dilewati.
- Media proyek arsip tetap terlindungi.
- Ekspor tanpa path/riwayat/file.
- Validasi impor membangun ulang dari kunci yang dikenal, jadi `__proto__` tidak berpengaruh.
- Auth/CSRF rute baru sama dengan rute lama.
- Path pembersihan terbatas pada id baru.
- Tidak ada stub/TODO/secret.
- Pratinjau dan render memakai layout yang sama.

## Temuan sendiri saat pelaksanaan (sudah diperbaiki di task-nya)
- X04: diff rencana Copilot tidak menampilkan perubahan volume/mute → kini tampil.
- X05: menu ⋯ Proyek keluar layar ke kiri di HP (x = −170px) → di layar sempit menu memakai lebar layar.

## Suite setelah perbaikan
core 226 pass / 1 skip (+3 `checkpointG-regressions`), server 86/86, web 11/11, typecheck, lint, smoke; UI Chrome W05–W15 + X01–X05 semua lulus (X05 12/12 dengan X5-07 baru); E2E 18/18; prototype 56/56; build demo OK.

## Risiko tersisa
- Perbedaan kosmetik pratinjau vs render: bayangan CSS vs stroke FFmpeg, jarak baris, font browser vs font sistem. Posisi, ukuran, warna, dan kotak sama.
- G-3 tanpa tes otomatis untuk kegagalan setelah manifest tertulis (butuh injeksi kegagalan fs).
