# Checkpoint E — audit W06–W09 + W11

- **Tanggal:** 2026-11-09
- **Cakupan:** `git diff 2df9550..62c8d44`, berisi:
  - W06 editor timeline
  - W07 pratinjau + streaming bertanda tangan
  - W08 render + hapus metadata
  - W09 login Google
  - PC-13 (tanpa Drive)
  - W11 Copilot

  W10 dibatalkan (PC-13), jadi checkpoint ini jatuh setelah W11 (5 task).
- **Hasil:** **LULUS setelah perbaikan**

## 1. Suite sebelum review
Semua hijau:
- verify: core 193 lulus / 1 skip, server 54, web 11, smoke
- UI Chrome: W05 20, W06 16, W07 19, W08 16, W09 14, W11 11
- E2E 18
- prototype 56

## 2. Review independen
- **Bekal reviewer:** subagent read-only, hanya diberi PRD, ADR-002, rencana v2.0, aturan owner W08, F7, dan diff. Tidak diberi kesimpulan pelaksana.
- **Cara verifikasi:** temuan direproduksi dengan skrip terhadap `dist`. Kalau tidak bisa direproduksi, temuan ditandai "dari membaca kode".
- **Hasil:** 0 High, 2 Medium, 9 Low, 1 Info.

| ID | Sev | Temuan | Status | Perbaikan + bukti |
|---|---|---|---|---|
| E1 | Med | Rencana yang merujuk klip buatan rencana itu sendiri (`plan_new_N`, contoh "potong di 3; potong di 6") lolos validasi tapi selalu gagal saat diterapkan. | **fixed** | `checkPlan` menolak operasi pada klip yang tidak ada di linimasa sekarang. `planLocal` memberi pesan jelas ("jalankan perintah pertama dulu"). Tes: `checkpointE-regressions` E1. |
| E2 | Med | `MOTION_PUBLIC_URL` https tanpa login Google tetap jalan dengan token URL saja, dan host publik diizinkan (fail-open). | **fixed** | Server menolak start bila URL publik non-loopback tanpa login Google. Tes: `checkpointE.test.ts` E2. |
| E3 | Low | Banjir `GET /api/auth/login` (500×) menggusur login yang sedang berjalan. | **fixed** | Tidak ada lagi map login tertunda di server. State + PKCE verifier + nonce disegel AES-GCM (kunci per start) di cookie state milik browser. Server hanya mengingat state yang sudah dipakai (tolak replay) sampai kedaluwarsa. Tes: 700 permintaan penyerang, login asli tetap sukses. Isi cookie tidak terbaca. |
| E4 | Low | Satu input FFmpeg per segmen: lebih dari ~250 potongan melewati batas command line Windows (32.767), lalu muncul pesan menyesatkan "FFmpeg tidak bisa dijalankan". | **fixed (batas)** | Lebih dari 200 segmen visual ditolak di awal (`PRECONDITION`) dengan alasan jelas. Tes E4: 200 klip ditolak, 50 klip menghasilkan perintah < 32.767 karakter. Grafik satu-input-per-versi dicatat untuk kebutuhan potong-hening nanti. |
| E5 | Low | Batal saat fase "menyimpan" tetap menyimpan output. | **fixed** | Cek batal tepat sebelum `commit`; file yang sudah di-stage dibuang. Tes E5 (FFmpeg nyata, batal disuntik setelah stage): `CANCELLED`, 05_OUTPUT kosong, lease dilepas. |
| E6 | Low | Kalau audit gagal setelah commit, status rencana kembali ke "proposed". | **fixed** | Status `applied` diset dulu, audit dibungkus sendiri, dan `catch` hanya mengembalikan status bila masih `applying`. |
| E7 | Low | Setujui sebagian tetap menampilkan diff seluruh rencana. | **fixed** | `POST …/copilot/plans/:id/preview {accept}`. Panel menghitung ulang diff untuk operasi yang dicentang, dengan label "operasi yang dicentang". Tes E7 (subset + 409 bila basi). |
| E8 | Low | Field keluaran planner AI (rationale/warnings/provider/cost) tidak dicek tipenya. | **fixed** | Disanitasi di `propose`: string terpotong, daftar string, biaya ≥0 dan finit. Tes E8 (input sampah menghasilkan 200 yang bersih). |
| E9 | Low | Job render selalu memakai `actor: 'user'`. | **fixed** | Aktor diteruskan dari pemanggil (route memakai aktor sesi). Tes E9: aktor `ai` gagal dengan `FORBIDDEN` dari core. |
| E10 | Low | Jumlah klip per linimasa tidak dibatasi. | **fixed** | Maksimal 2000 klip (`EDIT_INVALID`). Tes E10. |
| E11 | Low | Lease render bisa bocor (release gagal ditelan; PID dipakai ulang Windows). | **fixed sebagian** | Release dicoba ulang 4×. Sisa risiko: PID yang dipakai ulang setelah server crash membuat lease tetap dianggap hidup sampai server berikutnya. Dampaknya hanya media tertahan (aman, tidak menghapus), dan **diterima**. |
| E12 | Low | Cookie state https memakai `__Secure-`. Di mode loopback, cookie sesi terkirim ke semua layanan 127.0.0.1. | **fixed / dicatat** | Cookie state sekarang `__Host-motion_oauth; Path=/` (https). Loopback + Google dicatat sebagai mode uji. Online lewat domain https (W15). |
| E13 | Info | Rencana W09 masih menyebut refresh token disimpan. | **fixed** | Teks rencana diperbarui. `secrets.ts` kini dipakai key AI (W12). |

## 3. Suite setelah perbaikan
- verify: core 197 lulus / 1 skip (+4 regresi), server 58 (+4), web 11, smoke
- UI Chrome: W05 20, W06 16, W07 19, W08 16, W09 14, W11 11
- E2E 18
- prototype 56

Pekerjaan W12 yang sedang berjalan disimpan sementara (`git stash`) selama perbaikan, supaya commit checkpoint hanya berisi perbaikan.
