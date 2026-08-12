#!/usr/bin/env bash
# Restart the dashboard if it has stopped talking to the hub.
#
# systemd already restarts a process that CRASHES. This catches the other
# failure: a process that is alive and serving pages while its hub connection
# has died — which systemd cannot see. /api/health returns 503 in that case.
#
# Install (on the hub, as abneo):
#     crontab -e
#     */5 * * * * /home/abneo/dashboard/deploy/watchdog.sh
set -uo pipefail

PORT="${PORT:-3000}"
SERVICE=neo-dashboard
STAMP="${TMPDIR:-/tmp}/neo-watchdog.state"

# curl already prints 000 via -w when it cannot connect; the || is a fallback for
# the case where it prints nothing at all. Assigning rather than echoing keeps the
# two from concatenating into a confusing "000000" in the log.
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health") || code=000

if [[ "$code" == "200" ]]; then
  rm -f "$STAMP"
  exit 0
fi

# Only act on a second consecutive bad check, so one slow read is not a restart.
if [[ ! -f "$STAMP" ]]; then
  echo "$(date -Is) health=$code — first failure, waiting for confirmation" >&2
  touch "$STAMP"
  exit 0
fi

echo "$(date -Is) health=$code twice in a row — restarting $SERVICE" >&2
systemctl restart "$SERVICE" 2>/dev/null || sudo -n systemctl restart "$SERVICE"
rm -f "$STAMP"
