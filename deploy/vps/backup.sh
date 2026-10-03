#!/usr/bin/env bash
# Daily consistent backup of the autopilot database, keeping 14 days. Runs as the tradesense user.
set -euo pipefail
export PATH=/opt/node24/bin:$PATH
export AUTOPILOT_DB_PATH="${AUTOPILOT_DB_PATH:-/var/lib/tradesense/autopilot.sqlite}"
DEST=/var/backups/tradesense
cd /opt/tradesense/server
node scripts/backupDb.js "$DEST/autopilot-$(date +%F-%H%M).sqlite"
find "$DEST" -name 'autopilot-*.sqlite' -mtime +14 -delete
