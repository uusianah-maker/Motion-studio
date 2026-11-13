# Paket deploy Motion Studio (W15)

## Jalur B (dipakai sejak 13 Nov 2026): semua di VPS
Aplikasi, mesin (Generate Otomatis / Batch Remix), dan workspace jalan penuh di VPS. Tim bisa kerja bergantian kapan saja, dan PC owner boleh mati.

1. **DNS**: buat A record `motion` → IP VPS. Kalau DNS di Cloudflare, set ke DNS only (awan abu-abu).
2. **Di VPS** (Ubuntu 24.04, root):
   ```
   curl -fsSL https://raw.githubusercontent.com/uusianah-maker/Motion-studio/main/deploy/vps/setup-vps-penuh.sh -o setup-vps-penuh.sh
   sudo bash setup-vps-penuh.sh motion.domainlo.com
   ```
3. **Login Google**: ikuti `docs/SETUP_GOOGLE_LOGIN.md`. Redirect URI: `https://motion.domainlo.com/api/auth/callback`.
   - Isi tiga baris Google di `/srv/motion/app/.env.local` (lewat `nano`, jangan lewat chat).
   - Lalu jalankan `systemctl restart motion-studio`.
4. **Update** ke versi GitHub terbaru: jalankan lagi `setup-vps-penuh.sh` dengan domain yang sama. Data workspace tidak disentuh.
5. **Log**: `journalctl -u motion-studio -f`.

Catatan:
- Batch Remix di Linux masih butuh penyesuaian path Python di `engine/pipeline/batch/` (bagian yuki).
- Bagian di bawah ini adalah jalur A (VPS hanya pintu ke PC owner), disimpan sebagai cadangan.

Arahan owner (PC-14): **VPS cuma jadi pintu supaya app bisa dibuka online. File video, render (FFmpeg), dan semua data tetap di PC owner.**

```
Browser (HP / laptop / tim)
   │  https://motion.domainlo.com
   ▼
VPS  ── Caddy: HTTPS otomatis, meneruskan ke 127.0.0.1:14317
   │  terowongan SSH terenkripsi (dibuka DARI PC, jadi PC tidak perlu port terbuka)
   ▼
PC owner ── Motion Studio 127.0.0.1:4317 ── workspace (D:\…) + FFmpeg + key AI
```

- Satu VPS bisa dipakai beberapa app sekaligus (misalnya Affiliate OS di `affiliate.domainlo.com`). Contohnya ada di `vps/Caddyfile.example`.
- **App hanya bisa dibuka online selama PC owner menyala.** Upload, putar, dan unduh video lewat koneksi internet PC owner.
- VPS tidak menyimpan rahasia apa pun dari app. Client secret Google, API key AI, dan kunci enkripsinya semua tetap di PC.

## Yang dikerjakan owner (sekali)
Ada tanda "→ kirim ke Claude" di beberapa langkah. Itu artinya hasilnya boleh ditulis di chat karena bukan rahasia.

### 1. DNS
Di pengelola domain, buat **A record**: `motion` → IP VPS.
- Cek dengan `nslookup motion.domainlo.com`. Hasilnya harus IP VPS.
- Kalau DNS-nya di Cloudflare, set awan record ini ke **abu-abu (DNS only)**. Kalau awannya oranye, Cloudflare memotong upload di atas 100 MB.

### 2. Key SSH khusus terowongan (di PC, PowerShell)
```
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\motion_tunnel -N '""' -C motion-tunnel
Get-Content $env:USERPROFILE\.ssh\motion_tunnel.pub
```
- Key ini tidak pakai passphrase supaya terowongan bisa menyambung sendiri tanpa ditunggui.
- Key ini aman karena di VPS hanya boleh membuka satu port di loopback, tidak bisa dipakai login shell.
- Isi `.pub` adalah public key, boleh ditempel ke VPS. File tanpa `.pub` adalah kunci privat: **jangan dikirim ke siapa pun.**

### 3. Siapkan VPS (Ubuntu 22.04/24.04, login sebagai root atau user sudo)
Salin `deploy/vps/setup-vps.sh` ke VPS, lalu jalankan:
```
sudo bash setup-vps.sh motion.domainlo.com "ssh-ed25519 AAAA... motion-tunnel"
```
Skrip ini memasang:
- Caddy, dengan HTTPS otomatis;
- user `motiontunnel` tanpa shell, yang hanya boleh membuka `127.0.0.1:14317`;
- firewall yang hanya membuka SSH, 80, dan 443.

Skrip ini aman dijalankan ulang.

### 4. Login Google (PC-12)
Ikuti `docs/SETUP_GOOGLE_LOGIN.md`. Di bagian **Authorized redirect URIs**, isi dua alamat ini:
- `https://motion.domainlo.com/api/auth/callback`
- `http://127.0.0.1:4317/api/auth/callback` (opsional, untuk uji di PC)

### 5. `.env.local` di PC (folder repo)
```
MOTION_WORKSPACE=D:\VIBECODING\Motion Studio Workspace
MOTION_PORT=4317
MOTION_PUBLIC_URL=https://motion.domainlo.com
MOTION_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
MOTION_GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
MOTION_ALLOWED_EMAILS=email-lo@gmail.com
```
Kalau `MOTION_PUBLIC_URL` diisi alamat publik tapi login Google belum lengkap, server sengaja **menolak start**.

### 6. Kenalkan VPS ke PC (sekali)
```
ssh -i $env:USERPROFILE\.ssh\motion_tunnel motiontunnel@IP-VPS
```
- Cocokkan sidik jari VPS, lalu ketik `yes`.
- Pesan "This account is currently not available" itu normal: user ini memang tidak bisa login, cuma boleh membuat terowongan.

### 7. Nyalakan dan cek
```
npm run build
npm run check:deploy
powershell -ExecutionPolicy Bypass -File deploy\windows\start-motion.ps1
powershell -ExecutionPolicy Bypass -File deploy\windows\start-tunnel.ps1 -Vps IP-VPS
npm run check:deploy -- --url https://motion.domainlo.com
```
- `start-motion.ps1` dan `start-tunnel.ps1` masing-masing dijalankan di jendela PowerShell tersendiri.
- Log keduanya ada di `%LOCALAPPDATA%\MotionStudio\logs`.
- Hasil `check:deploy` terakhir harus `OK` semua → kirim ke Claude.

### 8. Otomatis menyala saat login Windows (opsional)
```
powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Vps IP-VPS
```
Untuk mencabut: jalankan skrip yang sama dengan `-Remove`.

## Mematikan / rollback
- **Matikan akses online:** tutup `start-tunnel.ps1`, atau `Stop-ScheduledTask MotionStudio-Tunnel`. App di PC tetap jalan.
- **Kembali ke mode lokal:** kosongkan `MOTION_PUBLIC_URL` dan variabel Google di `.env.local`, lalu restart server.
- **Lepas VPS:** hapus blok domain di `/etc/caddy/Caddyfile` (lalu `systemctl reload caddy`), dan `userdel -r motiontunnel`.

## Alternatif tanpa VPS: Cloudflare Tunnel
Contohnya di `cloudflare/config.example.yml`.
- **Kelebihan:** tidak perlu VPS.
- **Kekurangan:** paket gratis menolak upload di atas 100 MB, jadi tidak cocok untuk video besar.

## Cadangan (backup)
- **Workspace** (`MOTION_WORKSPACE`): berisi video, proyek, dan transkrip. Tetap di PC; ikuti aturan backup Motion Studio.
- **Folder state** (`%USERPROFILE%\.motion-studio`): berisi `ai-providers.json`, `secret.key`, dan `ai-usage.jsonl`. Cadangkan **berdua** `ai-providers.json` dan `secret.key`; tanpa `secret.key`, API key AI harus dimasukkan ulang.
