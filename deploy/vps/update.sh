#!/usr/bin/env bash
# Pull the latest code, rebuild the site and restart the service. Run as root.
set -euo pipefail
export PATH=/opt/node24/bin:$PATH
APP_DIR=/opt/tradesense
set -a
. /etc/tradesense/tradesense.env
set +a
cd "$APP_DIR"
git pull --ff-only
npm ci
VITE_API_BASE_URL="https://${APP_DOMAIN:?APP_DOMAIN missing in /etc/tradesense/tradesense.env}" npm run build
chmod -R o+rX "$APP_DIR/client/dist"
systemctl restart tradesense
echo "Updated and restarted. Follow the log with: journalctl -u tradesense -f"
