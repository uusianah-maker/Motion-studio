# Setup Login Google (W09) — langkah manual owner

Login Google butuh **OAuth Client ID** milik akun Google owner. Ini cuma bisa dibuat owner sendiri di Google Cloud Console, sekali saja, sekitar 10 menit. Client secret jangan pernah dikirim ke chat atau di-commit.

## 1. Buat project di Google Cloud
1. Buka https://console.cloud.google.com/ dan login dengan Gmail yang punya Drive 2 TB (PC-6).
2. Klik pemilih project di atas, lalu **New Project**. Isi nama `Motion Studio`, lalu **Create**. Setelah itu pastikan project ini yang aktif.
3. Buka menu **APIs & Services → Library**. Aktifkan **Google Drive API** dan **Google Picker API**. Dua API ini baru dipakai di W10, tapi aktifkan sekarang supaya beres sekali jalan.

## 2. Layar persetujuan (Google Auth Platform)
1. Buka menu **Google Auth Platform**. Kalau diminta, klik **Get started**.
2. Bagian **Branding**:
   - App name: `Motion Studio`.
   - User support email: Gmail lo.
   - Developer contact: Gmail lo.
   - Logo **jangan diisi**. Kalau ada logo, Google minta verifikasi.
3. **Audience**: pilih **External**. Lalu klik **Publish app** sampai statusnya **In production** (PC-6).
   - Kalau statusnya masih *Testing*, izin Drive kedaluwarsa tiap 7 hari dan lo harus login ulang.
4. **Data Access → Add or remove scopes**: centang empat scope ini, lalu **Save**:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/drive.file`. Artinya app cuma bisa akses file yang dibuat atau dipilih lewat app, bukan seluruh Drive.

   Keempatnya scope *non-sensitive*, jadi tidak perlu verifikasi Google.

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
2. Di halaman izin Google, **centang izin Google Drive**. Kalau tidak dicentang, app tetap bisa dibuka, tapi muncul peringatan dan W10 tidak bisa jalan.
3. Kalau muncul "Google hasn't verified this app", klik **Advanced → Go to Motion Studio**. Itu wajar karena app ini milik lo sendiri.

## Yang disimpan di mana
- **Client secret**: hanya di `.env.local` di komputer server. Di VPS nanti disimpan sebagai env server.
- **Refresh token Google** (izin Drive untuk W10):
  - Lokasi: `%USERPROFILE%\.motion-studio\google-tokens.json`, di luar workspace dan tidak ikut ke Drive.
  - Dienkripsi AES-256-GCM.
  - Kuncinya ada di `secret.key` di folder yang sama, atau di `MOTION_SECRET_KEY` kalau di-set (disarankan untuk VPS).
  - Kalau kunci hilang, cukup login ulang.
- **Browser**: hanya menyimpan cookie sesi HttpOnly. Token Google tidak pernah sampai ke browser.
- **Sesi**:
  - Habis setelah 12 jam tidak dipakai, atau paling lama 7 hari.
  - Restart server berarti login ulang, cukup satu klik.
- **Cabut akses kapan saja**: https://myaccount.google.com/permissions → Motion Studio → Remove access.
