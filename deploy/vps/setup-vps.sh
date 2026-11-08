#!/usr/bin/env bash
# Motion Studio — VPS sebagai "pintu" online (PC-14). Dijalankan OWNER di VPS (Ubuntu 22.04/24.04), sebagai root:
#   sudo bash setup-vps.sh motion.domainlo.com "ssh-ed25519 AAAA... motion-tunnel"
# Yang dilakukan (bisa diulang, aman dijalankan dua kali):
#   1. pasang Caddy (repo resmi) → HTTPS otomatis (Let's Encrypt) untuk domain itu;
#   2. buat user `motiontunnel` TANPA shell; key-nya HANYA boleh membuka 127.0.0.1:14317 di VPS (reverse tunnel);
#   3. Caddy meneruskan https://DOMAIN → 127.0.0.1:14317 → (terowongan SSH) → PC owner 127.0.0.1:4317;
#   4. firewall: hanya SSH, 80, 443.
# File video TIDAK pernah ada di VPS. VPS tidak menyimpan rahasia app (client secret, API key tetap di PC).
set -euo pipefail

DOMAIN="${1:-}"
PUBKEY="${2:-}"
TUNNEL_PORT=14317

if [[ $EUID -ne 0 ]]; then echo "Jalankan sebagai root (sudo)." >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Domain tidak valid: '$DOMAIN' (contoh: motion.domainlo.com)" >&2; exit 1
fi
if [[ ! "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]]; then
  echo "Public key harus satu baris 'ssh-ed25519 AAAA...' (isi file motion_tunnel.pub dari PC)." >&2; exit 1
fi

echo "==> Paket dasar"
apt-get update -y
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg ufw

echo "==> Caddy (repo resmi)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> User terowongan (tanpa shell, hanya reverse tunnel ke 127.0.0.1:${TUNNEL_PORT})"
id motiontunnel >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin motiontunnel
install -d -m 700 -o motiontunnel -g motiontunnel /home/motiontunnel/.ssh
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$TUNNEL_PORT" "$PUBKEY" > /home/motiontunnel/.ssh/authorized_keys
chown motiontunnel:motiontunnel /home/motiontunnel/.ssh/authorized_keys
chmod 600 /home/motiontunnel/.ssh/authorized_keys

cat > /etc/ssh/sshd_config.d/60-motiontunnel.conf <<'EOF'
# Motion Studio: user terowongan hanya boleh membuka port di loopback VPS, tidak bisa login shell.
Match User motiontunnel
    AllowTcpForwarding remote
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "==> Caddyfile"
BLOCK="# motion-studio:${DOMAIN}
${DOMAIN} {
	# Semua permintaan diteruskan apa adanya (Host tetap ${DOMAIN}) ke terowongan PC owner.
	reverse_proxy 127.0.0.1:${TUNNEL_PORT} {
		flush_interval -1
	}
	header Strict-Transport-Security \"max-age=15552000\"
	log
}
"
CADDYFILE=/etc/caddy/Caddyfile
if grep -q "^# motion-studio:${DOMAIN}\$" "$CADDYFILE" 2>/dev/null; then
  echo "Blok ${DOMAIN} sudah ada, tidak diubah."
else
  if grep -q '^:80 {' "$CADDYFILE" 2>/dev/null; then
    # Masih Caddyfile contoh bawaan paket: simpan cadangan, mulai dari kosong.
    cp "$CADDYFILE" "${CADDYFILE}.bawaan-$(date +%Y%m%d%H%M%S)"
    : > "$CADDYFILE"
  fi
  printf '%s\n' "$BLOCK" >> "$CADDYFILE"
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy

echo "==> Firewall (SSH, 80, 443)"
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
ufw allow "${SSH_PORT:-22}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "Selesai. Berikutnya di PC owner: jalankan deploy/windows/start-tunnel.ps1 -Vps <IP-VPS>"
echo "Lalu buka https://${DOMAIN} (sertifikat HTTPS dibuat otomatis saat pertama diakses; DNS ${DOMAIN} harus sudah menunjuk ke IP VPS ini)."
