# Backup workspace Motion Studio (R15)

Dua skrip PowerShell. Keduanya hanya MEMBACA workspace dan aman dijalankan saat server hidup.

| Skrip | Fungsi |
|---|---|
| `backup-workspace.ps1 -Tujuan <folder>` | Backup mingguan: snapshot data + media asli baru (+ render dengan `-DenganRender`), lalu verifikasi |
| `restore-workspace.ps1 -Backup <folder> -Target <folder baru>` | Menyusun workspace utuh dari backup ke folder baru, lalu verifikasi |

Opsi `backup-workspace.ps1`:

| Opsi | Arti |
|---|---|
| `-DenganRender` | Ikut menyalin hasil render |
| `-CekHash` | Cek SHA-256 (default: cek ukuran) |
| `-TanpaMedia` | Snapshot data ± 17 MB saja, misalnya ke Google Drive. Media ada di backup lain |
| `-Simpan N` | Jumlah snapshot yang disimpan (default 8) |
| `-Coba` | Hanya menampilkan rencana, tanpa menyalin |

## Isi backup

```
<Tujuan>\
  snapshots\2026-11-15_0200\   data kecil, satu folder per minggu, disimpan 8 terbaru (-Simpan)
      .motionstudio\           registry media, Brand Kit, kebijakan, audit, journal
      PROJECTS\<id>\03_PROJECT timeline + riwayat undo
      PROJECTS\<id>\06_ENGINE  rencana dan hasil mesin (JSON)
  media\                       media asli. Hanya file baru yang disalin, tidak pernah dihapus.
      SHARED_MEDIA, SHARED_ASSETS, PROJECTS\<id>\01_INPUT, 02_ASSETS
  renders\                     (opsional) PROJECTS\<id>\05_OUTPUT
  logs\backup-<tanggal>.log
```

Tidak dibackup karena bisa dibuat ulang atau merupakan salinan:
- cache (`04_CACHE`, `.motionstudio\visuals`, `analysis`)
- `.trash`
- `HASIL RENDER` (isinya sama dengan `05_OUTPUT`)
- `BACKUP_PROJECTS`

Urutannya snapshot dulu, baru media. Dengan begitu setiap media yang disebut registry di snapshot pasti ada di backup. Setelah menyalin, skrip mencocokkan setiap media aktif di registry dengan ukurannya, atau dengan SHA-256 kalau memakai `-CekHash`. Kalau ada yang tidak cocok, skrip keluar dengan kode 1.

## Uji 15 Nov 2026 (ke folder sementara)

| Langkah | Hasil |
|---|---|
| Backup pertama + render + `-CekHash` | 64 dtk, 178 media (1.216,6 MB) hash cocok, total backup 1,84 GB |
| Backup kedua (tanpa media baru) | 7 dtk, hanya snapshot baru (+17 MB) |
| Restore + `-CekHash` ke folder baru | 17 dtk, 178 media hash cocok |
| `motion-storage dashboard` pada hasil restore | terbuka normal; Brand Kit Aysilla terbaca, 74/74 proyek terbaca |
| Restore ke folder yang tidak kosong | ditolak (workspace yang ada tidak tertimpa) |

## Memulihkan workspace kerja

1. Pulihkan ke folder **baru**:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\backup\restore-workspace.ps1 -Backup E:\MotionBackup -Target D:\MotionPulih -CekHash
   ```
2. Cek hasilnya:
   ```
   node packages\core\dist\cli\motion-storage.js dashboard D:\MotionPulih
   ```
3. Kabari venus. Hentikan server (`Stop-ScheduledTask MotionStudio-Server`), ganti nama folder workspace lama, ganti nama `D:\MotionPulih` menjadi `Motion Studio Workspace`, lalu `Start-ScheduledTask MotionStudio-Server`.

## Jadwal (BELUM dipasang, menunggu owner memilih lokasi)

Setelah lokasi diputuskan, pasang satu task mingguan, misalnya Minggu 02.00:
```
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\VIBECODING\Video motion\deploy\backup\backup-workspace.ps1" -Tujuan "<LOKASI>" -DenganRender'
Register-ScheduledTask MotionStudio-Backup -Action $a -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 2am)
```
