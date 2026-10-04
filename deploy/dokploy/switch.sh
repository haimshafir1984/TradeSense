#!/usr/bin/env bash
# Kill switch for TradeSense on the shared Swarm node. Touches only the TradeSense service.
#   sudo tradesense-switch off     stop it completely (0 replicas, no CPU or memory)
#   sudo tradesense-switch on      start it again
#   sudo tradesense-switch status  show the replica state
# The Dokploy Deploy button starts it again too, so pause deploys during a campaign.
set -euo pipefail
SERVICE="${TRADESENSE_SERVICE:-tradesense-tradesense-3pkcvj}"
case "${1:-}" in
  off) docker service scale "$SERVICE=0" ;;
  on) docker service scale "$SERVICE=1" ;;
  status) docker service ls --filter "name=$SERVICE" --format '{{.Name}} {{.Replicas}}' ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
