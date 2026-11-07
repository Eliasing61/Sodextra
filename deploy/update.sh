#!/usr/bin/env bash
# Deploy the latest code (run as root on the VPS):  bash /opt/sodextra/deploy/update.sh
#
# Pulls, installs, runs the checks and restarts the API (the website deploys on
# Vercel by itself from GitHub). Running bots keep running (KillMode=process) on the code they started
# with; stop and start a bot from the website to move it to the new code.
set -euo pipefail
APP=/opt/sodextra
as_app() { sudo -u sodextra -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash update.sh)"; exit 1; }
cd "$APP"
as_app git pull --ff-only
as_app corepack pnpm install --frozen-lockfile
as_app npm run check
install -m 644 deploy/sodextra-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart sodextra-api
systemctl --no-pager --lines=5 status sodextra-api || true
