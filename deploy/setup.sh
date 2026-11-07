#!/usr/bin/env bash
# First-time VPS setup for Sodextra (Ubuntu 22.04 / 24.04). Run as root:
#
#   bash setup.sh git@github.com:<you>/sodextra.git sodextra.xyz
#
# Safe to run again: each step checks what is already there. What it does
# (docs/deployment.md):
#   1. Security updates, unattended upgrades, firewall (22, 80, 443 only), fail2ban,
#      SSH keys only (only if a key is already installed, so you can't lock yourself out).
#   2. Node 24, pnpm (corepack) and Caddy.
#   3. A locked-down "sodextra" user, a read-only GitHub deploy key, the code in /opt/sodextra.
#   4. Install and checks; .env with the site origin, a vault key and the proxy secret.
#      (The website itself runs on Vercel; this server runs the API and the bots.)
#   5. The API service and Caddy (HTTPS on api.<domain>), started once .env is filled in.
set -euo pipefail

REPO="${1:-}"
DOMAIN="${2:-sodextra.xyz}"
APP=/opt/sodextra
HOME_DIR=/var/lib/sodextra
DEPLOY_DIR="$APP/deploy"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
as_app() { sudo -u sodextra -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash setup.sh ...)"; exit 1; }
[ -n "$REPO" ] || { echo "Usage: bash setup.sh <git repo ssh url> [domain]"; exit 1; }

# ── 0. Shared server? Don't break what's already here ────────────────────────
say "Checking what already runs on this server"
listeners="$(ss -Htlnp 2>/dev/null || true)"
echo "$listeners"
# Ports we need on 127.0.0.1, unless our own services hold them.
if echo "$listeners" | grep -q ":3101 " && ! systemctl is-active -q sodextra-api; then
  echo "Port 3101 is taken by another program (above). Free it or change Sodextra's port first."
  exit 1
fi
# Something other than Caddy on 80/443 (nginx, apache, docker…) would fight Caddy for them.
if echo "$listeners" | grep -E ':(80|443) ' | grep -vq caddy; then
  echo "Something other than Caddy already serves ports 80/443 (above)."
  echo "Stop here: Sodextra's API site then belongs in that web server's config instead. Ask before going on."
  exit 1
fi
# Other public services (not loopback, not SSH/HTTP/HTTPS): keep the firewall from cutting them off.
OTHER_PUBLIC="$(echo "$listeners" | awk '{print $4}' |
  grep -vE '^(127\.|\[::1\]|localhost)' | grep -vE ':(22|80|443|3101)$' || true)"
if node --version 2>/dev/null | grep -qv '^v24\.'; then
  echo "Node $(node --version) is installed system-wide; Sodextra needs Node 24 and would upgrade it,"
  echo "which may affect other apps on this server."
  read -r -p "Type yes to upgrade Node to 24: " answer
  [ "$answer" = "yes" ] || exit 1
fi

# ── 1. Server basics ──────────────────────────────────────────────────────────
say "Security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl git ufw fail2ban unattended-upgrades ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https sqlite3
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "Firewall: SSH, HTTP, HTTPS"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
if ufw status | grep -q "Status: active"; then
  echo "ufw was already on; added 22/80/443, left your other rules as they are."
elif [ -n "$OTHER_PUBLIC" ]; then
  echo "WARNING: ufw is off and other services listen publicly (above), so it stays off"
  echo "to avoid cutting them off. Allow their ports with 'ufw allow <port>/tcp', then 'ufw enable'."
else
  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
fi
systemctl enable --now fail2ban

say "SSH: keys only"
if find /root/.ssh /home/*/.ssh -name authorized_keys -size +0 2>/dev/null | grep -q .; then
  cat >/etc/ssh/sshd_config.d/10-sodextra.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
  echo "Password logins are off. Keep your SSH key safe."
else
  echo "WARNING: no SSH key installed for any user, so password login stays ON."
  echo "Add your public key to ~/.ssh/authorized_keys and run this script again."
fi

# ── 2. Node 24, pnpm, Caddy ──────────────────────────────────────────────────
say "Node 24"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -yq nodejs
fi
node --version
corepack enable 2>/dev/null || npm install -g corepack && corepack enable

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

# ── 3. User, deploy key, code ────────────────────────────────────────────────
say "User sodextra"
if ! id sodextra >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin sodextra
fi
install -d -o sodextra -g sodextra -m 700 "$HOME_DIR/.ssh"
if [ ! -f "$HOME_DIR/.ssh/id_ed25519" ]; then
  as_app ssh-keygen -q -t ed25519 -N "" -C "sodextra-vps-deploy" -f "$HOME_DIR/.ssh/id_ed25519"
fi
if ! grep -qs '^github.com ' "$HOME_DIR/.ssh/known_hosts"; then
  as_app sh -c "ssh-keyscan -t ed25519 github.com >> '$HOME_DIR/.ssh/known_hosts' 2>/dev/null"
fi

if [ ! -d "$APP/.git" ]; then
  say "Deploy key"
  echo "Add this key on GitHub: repo → Settings → Deploy keys → Add (leave 'Allow write access' OFF):"
  echo
  cat "$HOME_DIR/.ssh/id_ed25519.pub"
  echo
  read -r -p "Press Enter once it's added… "
  install -d -o sodextra -g sodextra -m 750 "$APP"
  as_app git clone "$REPO" "$APP"
fi

# ── 4. Install, check, build ─────────────────────────────────────────────────
say "Install, checks, build (a few minutes)"
cd "$APP"
as_app git pull --ff-only
install -d -o sodextra -g sodextra -m 700 "$APP/.sodextra" "$APP/bots/web"
as_app corepack pnpm install --frozen-lockfile
as_app npm run check

say ".env"
if [ ! -f "$APP/.env" ]; then
  install -o sodextra -g sodextra -m 600 "$APP/.env.example" "$APP/.env"
  sed -i "s|^SODEXTRA_WEB_ORIGIN=.*|SODEXTRA_WEB_ORIGIN=https://$DOMAIN|" "$APP/.env"
  if ! grep -q '^SODEXTRA_VAULT_KEY=.\+' "$APP/.env"; then
    key="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
    sed -i "s|^SODEXTRA_VAULT_KEY=.*|SODEXTRA_VAULT_KEY=$key|" "$APP/.env"
  fi
fi
if ! grep -q '^SODEXTRA_PROXY_SECRET=.+' "$APP/.env"; then
  sed -i '/^SODEXTRA_PROXY_SECRET=/d' "$APP/.env"
  echo "SODEXTRA_PROXY_SECRET=$(openssl rand -hex 32)" >>"$APP/.env"
fi
chown sodextra:sodextra "$APP/.env"
chmod 600 "$APP/.env"

# ── 5. Services and HTTPS ────────────────────────────────────────────────────
say "systemd services and Caddy"
install -m 644 "$DEPLOY_DIR/sodextra-api.service" /etc/systemd/system/
# Our sites go between markers, so other sites in an existing Caddyfile stay.
caddyfile=/etc/caddy/Caddyfile
[ -f "$caddyfile" ] && cp "$caddyfile" "$caddyfile.bak-$(date +%Y%m%d%H%M%S)"
if [ -f "$caddyfile" ] && ! grep -q '^# >>> sodextra' "$caddyfile" &&
  grep -qE '^:80|^http://' "$caddyfile" && ! grep -vE '^\s*(#|$)' "$caddyfile" | grep -qvE '^:80|^\s|^}|^http://'; then
  : >"$caddyfile" # only Caddy's default welcome page was configured
fi
sed -i '/^# >>> sodextra/,/^# <<< sodextra/d' "$caddyfile" 2>/dev/null || true
{
  echo "# >>> sodextra (managed by /opt/sodextra/deploy/setup.sh)"
  sed "s/sodextra\.xyz/$DOMAIN/g" "$DEPLOY_DIR/Caddyfile"
  echo "# <<< sodextra"
} >>"$caddyfile"
caddy validate --config "$caddyfile" --adapter caddyfile
systemctl daemon-reload
systemctl enable sodextra-api caddy

# The old example's placeholder isn't an address.
sed -i 's/^SODEX_USER_ADDRESS=0x\.\.\.$/SODEX_USER_ADDRESS=/' "$APP/.env"
if grep -q '^SODEXTRA_ALLOWED_ADDRESSES=.\+' "$APP/.env" ||
  grep -q '^SODEX_USER_ADDRESS=0x[0-9a-fA-F]\{40\}' "$APP/.env"; then
  systemctl restart sodextra-api
  systemctl reload caddy
  say "Running"
  systemctl --no-pager --lines=0 status sodextra-api caddy || true
else
  say "Almost done"
  echo "Say who may sign in: SODEXTRA_ALLOWED_ADDRESSES in $APP/.env"
  echo "(wallet addresses, comma-separated, or * for anyone):"
  echo "  sudo -u sodextra nano $APP/.env"
  echo "then run this script again (or: systemctl restart sodextra-api && systemctl reload caddy)."
fi

say "Latency to SoDEX (connect, first byte; tens of ms is good)"
curl -o /dev/null -s -w '%{time_connect}s %{time_starttransfer}s\n' \
  https://mainnet-gw.sodex.dev/api/v1/perps/markets/symbols || true

echo
echo "Back up SODEXTRA_VAULT_KEY from $APP/.env somewhere private (a password manager)."
echo "DNS: an A record for api.$DOMAIN pointing at this server (the site itself points at Vercel)."
echo
echo "On Vercel (project → Settings → Environment Variables), set:"
echo "  SODEXTRA_API_URL=https://api.$DOMAIN"
echo "  $(grep '^SODEXTRA_PROXY_SECRET=' "$APP/.env")"
echo "then redeploy, open https://$DOMAIN/app, sign in with your wallet and create the bot key in Setup."
