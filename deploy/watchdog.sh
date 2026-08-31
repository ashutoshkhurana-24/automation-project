#!/usr/bin/env bash
# Restart whichever thing has stopped working.
#
# systemd already restarts a process that CRASHES. This catches the two failures
# it cannot see, and they need different remedies:
#
#   1. The dashboard is alive and serving pages while its hub connection has
#      died. /api/health returns 503. Restart the dashboard.
#
#   2. The hub is answering us perfectly and has stopped hearing the lighting
#      bus. Found on 2026-08-31: the vendor's own listener died at 03:36, so
#      every reading froze where it stood, every command still went out and
#      every lamp still obeyed, and each confirmation compared against the
#      frozen record and reported itself refused. It went unnoticed for ten
#      hours because nothing anywhere said so — /api/health was a clean 200
#      throughout, and it was right to be: our end was fine.
#
#      Restarting the DASHBOARD does nothing for this, which is exactly why it
#      is not part of the 200/503 verdict. It would flap the board every ten
#      minutes while the fault sat there. The thing to restart is the vendor's
#      app, and a restart of it is what fixed this by hand.
#
# Install (on the hub, as abneo):
#     crontab -e
#     */5 * * * * /home/abneo/dashboard/deploy/watchdog.sh
#
# Restarting the vendor app needs one sudoers line, since `sudo -n` is otherwise
# refused on this box. Without it this script says so once and changes nothing —
# it never fails silently, which is the whole point of it existing:
#     abneo ALL=(root) NOPASSWD: /bin/systemctl restart tistron_backend
set -uo pipefail

PORT="${PORT:-3000}"
SERVICE=neo-dashboard
VENDOR=tistron_backend
STAMP="${TMPDIR:-/tmp}/neo-watchdog.state"
BUS_STAMP="${TMPDIR:-/tmp}/neo-watchdog-bus.state"

# curl already prints 000 via -w when it cannot connect; the || is a fallback for
# the case where it prints nothing at all. Assigning rather than echoing keeps the
# two from concatenating into a confusing "000000" in the log.
body=$(curl -s -m 10 "http://127.0.0.1:${PORT}/api/health") || body=''
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health") || code=000

# ── 1. our own link to the hub ───────────────────────────────────────────────
if [[ "$code" != "200" ]]; then
  # Only act on a second consecutive bad check, so one slow read is not a restart.
  if [[ ! -f "$STAMP" ]]; then
    echo "$(date -Is) health=$code — first failure, waiting for confirmation" >&2
    touch "$STAMP"
    exit 0
  fi
  echo "$(date -Is) health=$code twice in a row — restarting $SERVICE" >&2
  systemctl restart "$SERVICE" 2>/dev/null || sudo -n systemctl restart "$SERVICE"
  rm -f "$STAMP"
  exit 0
fi
rm -f "$STAMP"

# ── 2. the hub's own ear on the bus ──────────────────────────────────────────
# `"ok":false` inside the bus block, and nothing else — null means "cannot tell
# from here", which is every instance that is not on the hub, and must never be
# read as a fault.
bus=$(printf '%s' "$body" | tr -d ' \n' | grep -o '"bus":{[^}]*}' || true)
if [[ -z "$bus" || "$bus" != *'"ok":false'* ]]; then
  rm -f "$BUS_STAMP"
  exit 0
fi

# Two consecutive checks here too: a poll can miss for its own reasons, and
# restarting the house's controller is not something to do on one reading.
if [[ ! -f "$BUS_STAMP" ]]; then
  echo "$(date -Is) bus silent — first failure, waiting for confirmation" >&2
  touch "$BUS_STAMP"
  exit 0
fi

echo "$(date -Is) bus silent twice in a row — restarting $VENDOR" >&2
if sudo -n systemctl restart "$VENDOR" 2>/dev/null; then
  echo "$(date -Is) restarted $VENDOR" >&2
  rm -f "$BUS_STAMP"
else
  # Say it every time rather than once. This is the branch where the house is
  # broken and nothing can fix it automatically, so a line in the log each cycle
  # is the only thing that will ever get somebody's attention.
  echo "$(date -Is) cannot restart $VENDOR — no passwordless sudo." >&2
  echo "  add:  abneo ALL=(root) NOPASSWD: /bin/systemctl restart $VENDOR" >&2
  echo "  or by hand:  sudo systemctl restart $VENDOR" >&2
fi
