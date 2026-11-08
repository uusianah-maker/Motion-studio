# Checkpoint F — audit W12–W15 (audit akhir rencana v2.0)

- **Tanggal:** 2026-11-09
- **Cakupan:** `git diff ecbe5ba..a612fe3`
  - W12 AI Provider Manager
  - W13 pemakaian + anggaran
  - W14 caption/STT
  - W15 paket deploy + E2E online
- **Hasil:** **LULUS setelah perbaikan**

## 1. Suite sebelum review
- verify: core 201 lulus / 1 skip, server 78, web 11, smoke
- UI W05–W14 hijau
- E2E online W15 16/16
- E2E 18
- prototype 56

## 2. Review independen
- **Bekal reviewer:** subagent read-only, diberi PRD (§0.1, §8, §10, §11, v0.4 failover, v0.5 manual enrollment), ADR-002 + PC-13, dan PC-14 di PROGRESS.
- **Cara verifikasi:** 6 temuan direproduksi dengan skrip terhadap `dist` + provider tiruan (tanpa panggilan nyata). Sisanya dari membaca kode.
- **Hasil:** 2 High, 5 Medium, 4 Low.

| ID | Sev | Temuan | Status | Perbaikan + bukti |
|---|---|---|---|---|
| F-1 | High | API key tersimpan bisa diarahkan ke host lain: ganti `base_url` lalu klik "Tes", key ikut terkirim. Provider resmi juga menerima `base_url` https apa pun. | **fixed** | (1) Mengganti alamat koneksi **menghapus key-nya** (wajib diisi ulang). (2) Provider resmi dikunci ke host resminya; endpoint loopback hanya boleh di mode uji (`MOTION_AI_DEV_ENDPOINTS=1`, dipakai tes). (3) Key disegel dengan AAD = `id|provider|host`, jadi mengedit alamat di file membuat key tak terbaca dan server menolak start. Tes `checkpointF` F-1. |
| F-2 | High | Panggilan gagal yang tetap ditagih provider (HTTP 200 `max_tokens`/refusal, timeout, 500) tercatat $0. Dari skrip reviewer: 8 panggilan berbayar (±$1,33) lolos batas harian $0,50. Batas per permintaan juga hanya dihitung per percobaan. | **fixed** | Usage dari balasan 200 ikut dicatat. Hasil yang tidak jelas (timeout, reset, 500/502/504) dihitung sebesar perkiraan. Batas per permintaan menjumlah semua percobaan + failover (`prior_usd`). Tes F-2 ×2: 3 panggilan lalu 402, buku = biaya nyata; retry 500 berhenti di batas per permintaan setelah 1 panggilan. |
| F-3 | Med | Transkripsi berbayar bisa dikirim ulang ke provider cadangan setelah kegagalan yang tidak jelas. | **fixed** | Transkripsi yang mungkin sudah diproses **tidak pernah dikirim ulang**, baik ke provider yang sama maupun lain. Hanya penolakan sebelum diproses (429/503/529, koneksi ditolak) yang boleh diulang/failover. Tes F-3. |
| F-4 | Med | `openai_compatible` lolos dari anggaran (gratis) dan bisa menunjuk ke api.openai.com sebagai "provider lain" (rotasi key vendor yang sama). | **fixed** | Hanya server di komputer ini (loopback) yang boleh gratis. Identitas failover = vendor: koneksi "kompatibel" ke host resmi dihitung sebagai vendor itu. Tes F-4. |
| F-5 | Med | `mode: 'ai'` per permintaan menimpa pengaturan admin "lokal". | **fixed** | Permintaan hanya boleh mempersempit mode, tidak memperluas. Tes F-5. |
| F-6 | Med | Cue hasil transkripsi bisa melanggar aturannya sendiri (<200 ms, melewati durasi), sehingga menyimpan transkrip yang belum diubah pun ditolak. | **fixed** | Kata yang dimulai di/sesudah akhir media dibuang. Cue terlalu pendek digabung ke cue sebelum/sesudahnya (tidak ada kata hilang). `validateCues` dijalankan sebelum simpan. Tes F-6 (4 kasus tepi). |
| F-7 | Low–Med | Kalau pencatatan gagal setelah panggilan berbayar sukses, router mengulang panggilan (bayar dua kali). | **fixed** | Pencatatan (buku, status, audit) dipindah ke luar blok retry dan tidak pernah memicu panggilan baru. Tes F-7 (`settle` gagal: 1 panggilan, hasil tetap kembali). |
| F-8 | Low | Job transkripsi: `mkdtemp` di luar `try` + `void run()` bisa menjatuhkan server. Audit gagal membuat job "gagal" padahal transkrip tersimpan. Cadangan yang lebih mahal ditandai error. | **fixed** | Semua di dalam `try`, job dibungkus `.catch`, audit tidak mengubah status. Cadangan mahal **dilewati** (`skip`) tanpa ditandai gagal. Tes F-8. |
| F-9 | Low | Konfirmasi biaya cukup "≥ perkiraan" (mis. 1000), sehingga pagu cadangan ikut naik. | **fixed** | Konfirmasi harus = perkiraan yang ditampilkan (toleransi 1%) **dan** `connection_id` yang dikutip. Pagu cadangan memakai perkiraan server. Tes F-9 (3 kombinasi salah → 409, 0 panggilan). |
| F-10 | Low | `setup-vps.sh`: (a) tanpa ClientAlive, port terowongan bisa tertahan ±2 jam; (b) newline di public key; (c) drop-in sshd rusak tertinggal; (d) hanya port SSH pertama dibuka firewall. | **fixed** | (a) `ClientAliveInterval 30` / `CountMax 3`; (b) newline/CR ditolak + regex komentar ketat; (c) drop-in dihapus bila `sshd -t` gagal; (d) semua port dari `sshd -T` dibuka + peringatan `ssh.socket`. Cek sintaks `bash -n` di E2E W15. **Belum dijalankan di VPS sungguhan.** |
| F-11 | Low | SSRF terbatas: IP privat/link-local diterima; teks error dari server jauh dipantulkan ke UI. | **fixed** | `https` hanya untuk nama domain (bukan IP literal), userinfo/IPv6 ditolak. Pesan error hanya `HTTP <status> <kode>` (tanpa teks bebas dari server jauh). Tes F-1/F-11. |

## 3. Suite setelah perbaikan
- verify: core 201 lulus / 1 skip, **server 85** (+6 `checkpointF`, +1 F-9 di `w14`; tes `w13` "gagal = $0" diganti sesuai F-2), web 11, smoke
- UI W05 20, W06 16, W07 19, W08 16, W09 14, W11 11, W12 13, W13 9, W14 11
- E2E online W15 16/16
- E2E 18
- prototype 56

## 4. Catatan
- Uji UI/E2E memakai provider tiruan di loopback, sehingga server uji dijalankan dengan `MOTION_AI_DEV_ENDPOINTS=1`. **Jangan set variabel ini di produksi.**
- Sewaktu memperbaiki F-10, satu perintah heredoc di shell pelaksana salah delimiter dan beberapa baris skrip VPS sempat dieksekusi di PC Windows. Semuanya gagal tanpa efek (`sshd`/`systemctl` tidak ada; `rm -f ""` tidak menghapus apa pun). Setelah itu perbaikan ditulis lewat file skrip.
