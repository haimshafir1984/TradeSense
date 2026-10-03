#!/usr/bin/env bash
# One-time server preparation for Ubuntu 24.04. Run as root from the cloned repo:
#   git clone <repo> /opt/tradesense && cd /opt/tradesense
#   sudo bash deploy/vps/setup.sh app.example.com
#
# Built to share a VPS with other projects: Node 24 is installed privately in /opt/node24 (the
# system Node is never touched), the firewall is only extended and never switched on, and the
# script stops if another program already owns ports 80/443.
# It does NOT start the service: fill in /etc/tradesense/tradesense.env and restore the
# database first.
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash deploy/vps/setup.sh app.example.com}"
APP_DIR=/opt/tradesense
NODE_DIR=/opt/node24
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (sudo)." >&2; exit 1; fi
if [ "$(cd "$SELF/../.." && pwd)" != "$APP_DIR" ]; then
  echo "The repository must be cloned to $APP_DIR (currently $(cd "$SELF/../.." && pwd))." >&2
  exit 1
fi

# Refuse to continue if something other than Caddy already serves 80/443.
BUSY="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)"
if [ -n "$BUSY" ]; then
  echo "Ports 80/443 are already used by another program:" >&2
  echo "$BUSY" >&2
  echo "Add this site to that web server instead of installing Caddy (see docs/VPS_MIGRATION_HANDOFF.md)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg git xz-utils cron debian-keyring debian-archive-keyring apt-transport-https

if [ ! -x "$NODE_DIR/bin/node" ]; then
  BASE=https://nodejs.org/dist/latest-v24.x
  FILE="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -o 'node-v24[0-9.]*-linux-x64\.tar\.xz' | head -1)"
  [ -n "$FILE" ] || { echo "Could not find a Node 24 build." >&2; exit 1; }
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && curl -fsSL "$BASE/SHASUMS256.txt" | grep " $FILE\$" | sha256sum -c -)
  mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "Using Node $(node -v) from $NODE_DIR"

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

id tradesense >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin tradesense
install -d -o tradesense -g tradesense -m 750 /var/lib/tradesense /var/backups/tradesense
install -d -m 755 /etc/tradesense

if [ ! -f /etc/tradesense/tradesense.env ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" "$SELF/tradesense.env.example" > /etc/tradesense/tradesense.env
  chmod 600 /etc/tradesense/tradesense.env
  echo "Created /etc/tradesense/tradesense.env - fill in the secret values."
else
  echo "Keeping existing /etc/tradesense/tradesense.env"
fi

sed "s/__DOMAIN__/$DOMAIN/g" "$SELF/Caddyfile.template" > /etc/caddy/Caddyfile
install -m 644 "$SELF/tradesense.service" /etc/systemd/system/tradesense.service
chmod +x "$SELF"/*.sh
echo "17 3 * * * tradesense $SELF/backup.sh >> /var/backups/tradesense/backup.log 2>&1" > /etc/cron.d/tradesense-backup
chmod 644 /etc/cron.d/tradesense-backup

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
else
  echo "NOTE: the firewall (ufw) is not active, so it was left alone. Enabling it can cut off other"
  echo "projects on this server; open 22, 80, 443 and every port they use before turning it on."
fi

cd "$APP_DIR"
npm ci
VITE_API_BASE_URL="https://$DOMAIN" npm run build
chmod -R o+rX "$APP_DIR/client/dist"

systemctl daemon-reload
systemctl enable tradesense
systemctl reload caddy || systemctl restart caddy

echo
echo "Setup finished for https://$DOMAIN. The service is enabled but NOT started."
echo "Next: edit /etc/tradesense/tradesense.env, restore the database, then: systemctl start tradesense"
