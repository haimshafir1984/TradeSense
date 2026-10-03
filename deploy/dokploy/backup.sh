#!/usr/bin/env bash
# Daily consistent SQLite backup for the TradeSense app running under Dokploy. Run on the host as
# root (cron). The backup is written into the persistent /data volume and old ones are removed.
#   usage: backup.sh <part of the Docker service/container name, e.g. tradesense>
set -euo pipefail
NAME="${1:?Usage: backup.sh <container-name-fragment>}"
HOST_DATA="${TRADESENSE_HOST_DATA:-/var/lib/tradesense}"
CONTAINER="$(docker ps --filter "name=${NAME}" --format '{{.Names}}' | head -n 1)"
[ -n "$CONTAINER" ] || { echo "No running container matches '${NAME}'." >&2; exit 1; }
docker exec "$CONTAINER" node server/scripts/backupDb.js "/data/backups/autopilot-$(date +%F-%H%M).sqlite"
find "$HOST_DATA/backups" -name 'autopilot-*.sqlite' -mtime +14 -delete
