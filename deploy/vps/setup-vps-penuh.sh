#!/usr/bin/env bash
# Motion Studio — jalur B: aplikasi, mesin, dan workspace PENUH di VPS (tidak butuh PC owner menyala).
# Aman untuk VPS yang DIPAKAI BERSAMA app lain (mis. Affiliate OS):
#   - Node.js & Python milik Motion Studio dipasang privat di /srv/motion (Node/Python sistem tidak diubah);
#   - web server: hanya MENAMBAH blok domain di Caddy; berhenti kalau port 80/443 dipegang Nginx/Apache;
#   - firewall: hanya menambah izin 80/443/SSH, tidak menyalakan ufw yang sedang mati;
#   - prioritas CPU/disk Motion Studio lebih rendah dari app lain (render/Whisper tidak bikin app lain lemot).
#
# Pakai (root):
#   curl -fsSL https://raw.githubusercontent.com/uusianah-maker/Motion-studio/main/deploy/vps/setup-vps-penuh.sh -o setup-vps-penuh.sh
#   bash setup-vps-penuh.sh --cek                    # hanya MELAPOR, tidak mengubah apa pun
#   bash setup-vps-penuh.sh motion.domainlo.com      # pasang / update
# Aman diulang: menjalankan lagi = update ke versi GitHub terbaru (kode + mesin), data workspace tidak disentuh.
#
# Hasil:
#   /srv/motion/app        kode (git clone repo Motion-studio; mesin ada di app/engine)
#   /srv/motion/workspace  proyek, video, hasil render (MOTION_WORKSPACE)
#   /srv/motion/state      kunci rahasia app & API key AI (MOTION_STATE_DIR)
#   /srv/motion/hf-cache   model Whisper (diunduh otomatis saat transkrip pertama)
#   /srv/motion/node, /srv/motion/python  runtime privat
#   service systemd `motion-studio` (127.0.0.1:4317) + blok Caddy HTTPS untuk domain
set -euo pipefail

REPO="${MOTION_REPO:-https://github.com/uusianah-maker/Motion-studio.git}"
BRANCH="${MOTION_BRANCH:-main}"
NODE_VER="${MOTION_NODE_VERSION:-22.21.1}"
BASE=/srv/motion
APP="$BASE/app"
PORT=4317

if [[ $EUID -ne 0 ]]; then echo "Jalankan sebagai root (sudo)." >&2; exit 1; fi

pemegang_port() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2; }

lapor() {
  . /etc/os-release
  echo "OS        : ${PRETTY_NAME:-?}"
  echo "CPU       : $(nproc) core"
  echo "RAM       : $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo) (swap: $(awk '/SwapTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo))"
  echo "Disk /    : $(df -h / | awk 'NR==2{print $4" kosong dari "$2}')"
  echo "GPU       : $(command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name --format=csv,noheader | head -1 || echo tidak ada)"
  echo "Port 80   : $(pemegang_port 80 || true)"
  echo "Port 443  : $(pemegang_port 443 || true)"
  echo "Port $PORT : $(pemegang_port $PORT || true)"
  echo "Node      : $(command -v node >/dev/null && node -v || echo tidak ada)"
  echo "Python    : $(python3 --version 2>/dev/null || echo tidak ada)"
  echo "FFmpeg    : $(command -v ffmpeg >/dev/null && ffmpeg -version | head -1 | cut -d' ' -f1-3 || echo tidak ada)"
  echo "Docker    : $(command -v docker >/dev/null && echo "ada ($(docker ps -q 2>/dev/null | wc -l) container jalan)" || echo tidak ada)"
  echo "Caddy     : $(command -v caddy >/dev/null && caddy version | cut -d' ' -f1 || echo tidak ada)"
  echo "Nginx     : $(command -v nginx >/dev/null && echo ada || echo tidak ada)"
  echo "PM2       : $(command -v pm2 >/dev/null && echo ada || echo tidak ada)"
  echo "Firewall  : $(ufw status 2>/dev/null | head -1 || echo 'ufw tidak ada')"
  echo "Motion    : $([[ -d $APP/.git ]] && echo "terpasang ($(git -C $APP log -1 --format=%h 2>/dev/null))" || echo belum)"
  echo "App lain yang mendengar di port publik:"
  ss -ltnpH 2>/dev/null | awk '$4 !~ /^(127\.|\[::1\])/ {print "  " $4 "  " $6}' | sed 's/users:((//; s/,pid=.*//' | sort -u
}

if [[ "${1:-}" == "--cek" ]]; then lapor; exit 0; fi

DOMAIN="${1:-}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Domain tidak valid: '$DOMAIN' (contoh: motion.domainlo.com). Untuk cek VPS saja: bash $0 --cek" >&2; exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then echo "Skrip ini untuk Ubuntu. Terdeteksi: ${PRETTY_NAME:-?}" >&2; exit 1; fi

echo "==> Cek bentrok dengan app lain"
P80="$(pemegang_port 80 || true)"; P443="$(pemegang_port 443 || true)"; PAPP="$(pemegang_port $PORT || true)"
for p in "$P80" "$P443"; do
  if [[ -n "$p" && "$p" != "caddy" ]]; then
    echo "Port 80/443 dipegang '$p', bukan Caddy. Skrip berhenti supaya app lain tidak terganggu; tidak ada yang diubah." >&2
    echo "Kirim hasil 'bash $0 --cek' ke Claude untuk dibuatkan konfigurasi '$p'." >&2
    exit 1
  fi
done
if [[ -n "$PAPP" ]] && ! systemctl is-active --quiet motion-studio; then
  echo "Port $PORT sudah dipakai '$PAPP' (bukan Motion Studio). Skrip berhenti; tidak ada yang diubah." >&2; exit 1
fi
FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
if (( FREE_GB < 30 )); then echo "Disk kosong cuma ${FREE_GB} GB (minimal 30 GB). Skrip berhenti." >&2; exit 1; fi

echo "==> Paket dasar (git, FFmpeg) — tidak mengubah Node/Python sistem"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ffmpeg xz-utils debian-keyring debian-archive-keyring apt-transport-https

echo "==> Swap (dibuat hanya kalau belum ada swap sama sekali dan RAM < 8 GB)"
RAM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
if (( RAM_MB < 8000 )) && ! swapon --show | grep -q . && [[ ! -e /swapfile ]]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> User & folder"
id motion >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin motion
install -d -m 750 -o motion -g motion "$BASE" "$BASE/workspace" "$BASE/hf-cache"
install -d -m 700 -o motion -g motion "$BASE/state"
NODE_DIR="$BASE/node"
PATH_M="$NODE_DIR/bin:$BASE/bin:/usr/local/bin:/usr/bin:/bin"
as_motion() { runuser -u motion -- env HOME="$BASE" PATH="$PATH_M" UV_PYTHON_INSTALL_DIR="$BASE/python" "$@"; }

echo "==> Node.js $NODE_VER privat ($NODE_DIR)"
if [[ "$("$NODE_DIR/bin/node" -v 2>/dev/null)" != "v$NODE_VER" ]]; then
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) NA=x64;; aarch64) NA=arm64;; *) echo "Arsitektur $ARCH tidak didukung" >&2; exit 1;; esac
  TMPN="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-$NA.tar.xz" -o "$TMPN/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt" -o "$TMPN/SHASUMS256.txt"
  (cd "$TMPN" && grep " node-v$NODE_VER-linux-$NA.tar.xz\$" SHASUMS256.txt | sed "s#node-v.*#node.tar.xz#" | sha256sum -c -)
  rm -rf "$NODE_DIR" && install -d -o motion -g motion "$NODE_DIR"
  tar -xJf "$TMPN/node.tar.xz" -C "$NODE_DIR" --strip-components=1 && chown -R motion:motion "$NODE_DIR"
  rm -rf "$TMPN"
fi

echo "==> Python 3.12 privat untuk mesin (uv)"
install -d -o motion -g motion "$BASE/bin" "$BASE/python"
if [[ ! -x "$BASE/bin/uv" ]]; then
  as_motion bash -c "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR='$BASE/bin' INSTALLER_NO_MODIFY_PATH=1 sh"
fi

echo "==> Caddy (HTTPS otomatis)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Kode dari GitHub ($REPO, $BRANCH)"
if [[ -d "$APP/.git" ]]; then
  as_motion git -C "$APP" fetch --depth 1 origin "$BRANCH"
  as_motion git -C "$APP" reset --hard "origin/$BRANCH"   # .env.local & .venv tidak dilacak git: aman
else
  as_motion git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi

echo "==> Build aplikasi"
as_motion bash -c "cd '$APP' && nice -n 10 npm ci --no-audit --no-fund && nice -n 10 npm run build"

echo "==> Mesin (venv Python 3.12 + Whisper, OpenCV)"
[[ -x "$APP/engine/.venv/bin/python" ]] || as_motion "$BASE/bin/uv" venv --python 3.12 "$APP/engine/.venv"
as_motion "$BASE/bin/uv" pip install --quiet --python "$APP/engine/.venv/bin/python" -r "$APP/engine/pipeline/requirements.txt"

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

echo "==> Service systemd motion-studio (prioritas di bawah app lain)"
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
Environment=PATH=$PATH_M
ExecStart=$NODE_DIR/bin/node $APP/apps/server/dist/main.js
Restart=on-failure
RestartSec=5
# Render & Whisper berat: kalah prioritas dari app lain di VPS yang sama.
Nice=10
CPUWeight=50
IOWeight=50
MemoryHigh=70%
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable motion-studio >/dev/null

echo "==> Caddyfile (hanya menambah blok ${DOMAIN}; blok app lain tidak disentuh)"
CADDYFILE=/etc/caddy/Caddyfile
cp "$CADDYFILE" "${CADDYFILE}.sebelum-motion-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
if grep -q '^:80 {' "$CADDYFILE" 2>/dev/null && [[ "$(grep -c '{' "$CADDYFILE")" -le 1 ]]; then
  : > "$CADDYFILE"   # masih Caddyfile contoh bawaan paket
fi
if grep -q "^# motion-studio:${DOMAIN}\$" "$CADDYFILE" 2>/dev/null; then
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

echo "==> Firewall"
if ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  echo "ufw aktif: port 80 & 443 diizinkan (aturan lain tidak diubah)."
else
  echo "ufw tidak aktif: dibiarkan apa adanya supaya app lain tidak terputus."
fi

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
