# Setup Login Google (W09) — langkah manual owner

Login Google (untuk mengamankan app saat dibuka online) butuh **OAuth Client ID** milik akun Google owner. Ini cuma bisa dibuat owner sendiri di Google Cloud Console, sekali saja, sekitar 10 menit. Client secret jangan pernah dikirim ke chat atau di-commit.

## 1. Buat project di Google Cloud
1. Buka https://console.cloud.google.com/ dan login dengan Gmail lo.
2. Klik pemilih project di atas, lalu **New Project**. Isi nama `Motion Studio`, lalu **Create**. Setelah itu pastikan project ini yang aktif.
3. Tidak perlu mengaktifkan API apa pun (Drive tidak dipakai, PC-13).

## 2. Layar persetujuan (Google Auth Platform)
1. Buka menu **Google Auth Platform**. Kalau diminta, klik **Get started**.
2. Bagian **Branding**:
   - App name: `Motion Studio`.
   - User support email: Gmail lo.
   - Developer contact: Gmail lo.
   - Logo **jangan diisi**. Kalau ada logo, Google minta verifikasi.
3. **Audience**: pilih **External**. Lalu klik **Publish app** sampai statusnya **In production** (PC-6).
   - Status *Testing* juga bisa dipakai, tapi akunnya harus didaftarkan sebagai test user.
4. **Data Access → Add or remove scopes**: centang tiga scope ini, lalu **Save**:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`

   Ketiganya scope *non-sensitive* (cuma nama + email), jadi tidak perlu verifikasi Google. App tidak minta akses Drive, Gmail, atau data Google lain.

## 3. Buat OAuth Client
1. Buka **Google Auth Platform → Clients → Create client**.
2. Application type: **Web application**. Name: `Motion Studio lokal`.
3. **Authorized JavaScript origins**: `http://127.0.0.1:4317`
4. **Authorized redirect URIs**: `http://127.0.0.1:4317/api/auth/callback`
   - Tulis persis seperti itu: pakai `127.0.0.1`, **bukan** `localhost`, dan port `4317`.
   - Nanti di VPS (W15) tinggal tambah `https://<domain>/api/auth/callback`.
5. Klik **Create**. Lalu **salin Client ID dan Client secret saat itu juga**, atau unduh JSON-nya. Google cuma menampilkan secret sekali.

## 4. Isi `.env.local` di komputer server
Buat file `.env.local` di folder repo (sejajar `package.json`). File ini sudah di-`.gitignore` jadi tidak ikut ke git. Isinya:

```
MOTION_WORKSPACE=D:\path\ke\workspace
MOTION_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
MOTION_GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
MOTION_ALLOWED_EMAILS=email-lo@gmail.com
```

- `MOTION_ALLOWED_EMAILS`: daftar email yang boleh masuk, dipisah koma. Email lain ditolak.
- Kalau ketiga variabel Google diisi, mode token URL lama mati otomatis. Kalau cuma sebagian yang diisi, server **menolak start**. Ini sengaja supaya server tidak pernah terbuka tanpa login.

## 5. Coba
```
npm run start:server
```
1. Buka `http://127.0.0.1:4317/`, lalu klik **Masuk dengan Google** dan pilih akun.
2. Kalau muncul "Google hasn't verified this app", klik **Advanced → Go to Motion Studio**. Itu wajar karena app ini milik lo sendiri.

## Yang disimpan di mana
- **Client secret**: hanya di `.env.local` di komputer server. Di VPS nanti disimpan sebagai env server.
- **Token Google**: tidak disimpan sama sekali. Server cuma membaca email dari Google sekali saat login, lalu membuat sesinya sendiri.
- **Browser**: hanya menyimpan cookie sesi HttpOnly.
- **Sesi**:
  - Habis setelah 7 hari tidak dipakai, atau paling lama 30 hari.
  - Restart server **tidak** membuat tim ter-logout: sesi disimpan di `<folder state>/sessions.json` (hanya sidik sha256 ID sesi, bukan cookie dan bukan token Google).
  - Render dan Generate Otomatis jalan di server, jadi tetap lanjut walaupun laptop tim ter-logout atau ditutup.
- **File video**: tetap di disk komputer/server yang menjalankan app (PC-13), bukan di Google.
- **Cabut akses kapan saja**: https://myaccount.google.com/permissions → Motion Studio → Remove access.

## 6. Menambah anggota tim dari web (halaman Tim)
Setelah login sebagai **owner**, buka menu **Tim** di rail kiri. Menu ini hanya muncul untuk owner dan hanya saat login Google aktif.

1. Ketik email Google anggota, pilih perannya (**Editor**, **Reviewer**, atau **Owner**), lalu klik **Tambah**.
2. **Selama app Google masih status Testing**, email baru itu juga harus ditambahkan sebagai **Test user** di Google Auth Platform → **Audience** → **Test users** → **Add users**. Kalau belum, Google menolak login email itu sebelum sampai ke Motion Studio. Kalau app sudah **In production**, langkah ini tidak perlu.
3. Selesai. Tidak perlu edit `.env.local` dan tidak perlu restart server.

Aturan yang dijaga server:
- **Langsung berlaku.** Login, setiap request, dan peran selalu membaca daftar terbaru. Ganti peran langsung berlaku di sesi yang sedang jalan. Email yang dihapus langsung keluar di request berikutnya, dan login berikutnya ditolak.
- **Email dari `.env.local` terkunci.** Email di `MOTION_ALLOWED_EMAILS` (dan perannya dari `MOTION_OWNER_EMAILS` / `MOTION_EDITOR_EMAILS` / `MOTION_REVIEWER_EMAILS`) tetap berlaku dan hanya bisa diubah di `.env.local`. Jadi owner di `.env.local` tidak mungkin terkunci keluar lewat web. Kalau tidak ada daftar peran di env, semua email env adalah owner, sama seperti sebelumnya.
- **Selalu ada minimal satu owner.** Owner terakhir tidak bisa dihapus atau diturunkan perannya.
- **Akun sendiri tidak bisa diubah dari web.** Minta owner lain yang mengubahnya.
- **Hanya owner** yang bisa melihat dan mengubah daftar ini. API `GET/POST/PUT/DELETE /api/team` ditolak (403) untuk editor dan reviewer.

Penyimpanan:
- Anggota yang ditambah dari web disimpan di `%USERPROFILE%\.motion-studio\team.json` (atau di `MOTION_STATE_DIR` kalau di-set). File ini di luar workspace dan di luar git, dan isinya hanya email, peran, serta kapan dan oleh siapa ditambahkan. Tidak ada secret di dalamnya.
- Kalau file itu rusak, server **menolak start** dengan pesan yang menyebut lokasi file. Perbaiki atau hapus file itu. Kalau dihapus, yang tersisa hanya email dari `.env.local`.
- Setiap tambah, ganti peran, dan hapus dicatat di audit log workspace (`team.add`, `team.role`, `team.remove`).
