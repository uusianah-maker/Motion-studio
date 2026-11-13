#!/usr/bin/env bash
# Motion Studio — jalur B: aplikasi, mesin, dan workspace PENUH di VPS (tidak butuh PC owner menyala).
# Dijalankan OWNER di VPS Ubuntu 24.04 sebagai root:
#   curl -fsSL https://raw.githubusercontent.com/uusianah-maker/Motion-studio/main/deploy/vps/setup-vps-penuh.sh -o setup-vps-penuh.sh
#   sudo bash setup-vps-penuh.sh motion.domainlo.com
# Aman diulang: menjalankan lagi = update ke versi GitHub terbaru (kode + mesin), data workspace tidak disentuh.
#
# Hasil:
#   /srv/motion/app        kode (git clone repo Motion-studio; mesin ada di app/engine)
#   /srv/motion/workspace  proyek, video, hasil render (MOTION_WORKSPACE)
#   /srv/motion/state      kunci rahasia app & API key AI (MOTION_STATE_DIR) — ikut dicadangkan
#   /srv/motion/hf-cache   model Whisper (diunduh otomatis saat transkrip pertama)
#   service systemd `motion-studio` (127.0.0.1:4317) + Caddy HTTPS untuk domain + firewall SSH/80/443
set -euo pipefail

DOMAIN="${1:-}"
REPO="${MOTION_REPO:-https://github.com/uusianah-maker/Motion-studio.git}"
BRANCH="${MOTION_BRANCH:-main}"
BASE=/srv/motion
APP="$BASE/app"
PORT=4317

if [[ $EUID -ne 0 ]]; then echo "Jalankan sebagai root (sudo)." >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Domain tidak valid: '$DOMAIN' (contoh: motion.domainlo.com)" >&2; exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then echo "Skrip ini untuk Ubuntu (24.04). Terdeteksi: ${PRETTY_NAME:-?}" >&2; exit 1; fi

echo "==> Paket dasar (git, FFmpeg, Python, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw ffmpeg python3 python3-venv debian-keyring debian-archive-keyring apt-transport-https
PYV="$(python3 -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])')"
if (( PYV < 312 )); then
  echo "Mesin butuh Python 3.12+ (Ubuntu 24.04). Python di VPS ini: $(python3 --version). Install ulang VPS dengan Ubuntu 24.04." >&2
  exit 1
fi

echo "==> Swap (build & Whisper butuh memori; dibuat kalau RAM < 8 GB dan belum ada swap)"
RAM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
if (( RAM_MB < 8000 )) && ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Node.js 22"
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

echo "==> Caddy (HTTPS otomatis)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> User & folder"
id motion >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin motion
install -d -m 750 -o motion -g motion "$BASE" "$BASE/workspace" "$BASE/hf-cache"
install -d -m 700 -o motion -g motion "$BASE/state"
as_motion() { runuser -u motion -- env HOME="$BASE" "$@"; }

echo "==> Kode dari GitHub ($REPO, $BRANCH)"
if [[ -d "$APP/.git" ]]; then
  as_motion git -C "$APP" fetch --depth 1 origin "$BRANCH"
  as_motion git -C "$APP" reset --hard "origin/$BRANCH"   # .env.local & .venv tidak dilacak git: aman
else
  as_motion git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi

echo "==> Build aplikasi"
as_motion bash -c "cd '$APP' && npm ci --no-audit --no-fund && npm run build"

echo "==> Mesin (Python venv + Whisper, OpenCV)"
[[ -x "$APP/engine/.venv/bin/python" ]] || as_motion python3 -m venv "$APP/engine/.venv"
as_motion "$APP/engine/.venv/bin/pip" install --quiet --upgrade pip
as_motion "$APP/engine/.venv/bin/pip" install --quiet -r "$APP/engine/pipeline/requirements.txt"

echo "==> Pengaturan (.env.local) — rahasia diisi owner sendiri, tidak lewat chat"
ENVF="$APP/.env.local"
if [[ ! -f "$ENVF" ]]; then
  cat > "$ENVF" <<EOF
# Motion Studio di VPS. Isi 3 baris Google di bawah (docs/SETUP_GOOGLE_LOGIN.md), lalu: systemctl restart motion-studio
MOTION_WORKSPACE=$BASE/workspace
MOTION_PORT=$PORT
MOTION_PUBLIC_URL=https://$DOMAIN
MOTION_STATE_DIR=$BASE/state
MOTION_ENGINE_ROOT=$APP/engine
MOTION_GOOGLE_CLIENT_ID=
MOTION_GOOGLE_CLIENT_SECRET=
MOTION_ALLOWED_EMAILS=
EOF
  chown motion:motion "$ENVF"
  chmod 600 "$ENVF"
fi

echo "==> Service systemd motion-studio"
cat > /etc/systemd/system/motion-studio.service <<EOF
[Unit]
Description=Motion Studio
After=network-online.target
Wants=network-online.target

[Service]
User=motion
Group=motion
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=HOME=$BASE
Environment=HF_HOME=$BASE/hf-cache
ExecStart=/usr/bin/node $APP/apps/server/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable motion-studio >/dev/null

echo "==> Caddyfile"
CADDYFILE=/etc/caddy/Caddyfile
if grep -q '^:80 {' "$CADDYFILE" 2>/dev/null; then
  cp "$CADDYFILE" "${CADDYFILE}.bawaan-$(date +%Y%m%d%H%M%S)"
  : > "$CADDYFILE"
fi
if grep -q "^# motion-studio:${DOMAIN}\$" "$CADDYFILE" 2>/dev/null; then
  # Blok lama (mis. jalur A: terowongan 14317) diarahkan ke app lokal VPS.
  sed -i "/^# motion-studio:${DOMAIN//./\\.}\$/,/^}/ s/127\.0\.0\.1:14317/127.0.0.1:${PORT}/" "$CADDYFILE"
else
  cat >> "$CADDYFILE" <<EOF
# motion-studio:${DOMAIN}
${DOMAIN} {
	reverse_proxy 127.0.0.1:${PORT} {
		flush_interval -1
	}
	header Strict-Transport-Security "max-age=15552000"
	log
}

EOF
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl enable --now caddy >/dev/null
systemctl reload caddy

echo "==> Firewall (SSH, 80, 443)"
SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -u)"
for p in ${SSH_PORTS:-22}; do ufw allow "${p}/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Cek mesin"
as_motion bash -c "cd '$APP/engine' && HF_HOME='$BASE/hf-cache' .venv/bin/python pipeline/engine.py cek" || true

echo
if grep -qE '^MOTION_GOOGLE_CLIENT_SECRET=.+' "$ENVF"; then
  systemctl restart motion-studio
  sleep 3
  systemctl --no-pager --lines=5 status motion-studio || true
  echo "Selesai. Buka https://${DOMAIN}"
else
  echo "Hampir selesai. Tinggal login Google:"
  echo "  1. nano $ENVF   -> isi MOTION_GOOGLE_CLIENT_ID, MOTION_GOOGLE_CLIENT_SECRET, MOTION_ALLOWED_EMAILS"
  echo "  2. systemctl restart motion-studio"
  echo "  3. buka https://${DOMAIN}"
fi
echo "Update ke versi GitHub terbaru kapan saja: jalankan lagi skrip ini (data tidak disentuh)."
