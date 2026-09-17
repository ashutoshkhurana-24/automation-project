#!/usr/bin/env bash
# Restart whichever thing has stopped working.
#
# systemd already restarts a process that CRASHES. This catches the three failures
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
#   3. Everything is healthy and we are calling an address the hub no longer
#      holds. Found on 2026-09-17: the router was replaced, the static
#      reservation went with it, the hub slid from .3 to .2 on DHCP and another
#      device took .3 — so a real host answered and refused 8090. That is
#      ECONNREFUSED, byte for byte the same string as fault 2, and this script
#      restarted the vendor's app eighteen times in three hours while nothing
#      whatever was wrong with it.
#
#      Restarting ANYTHING is wrong here. The string cannot separate the two,
#      but this script runs on the hub, so it can ask the question that can:
#      is that port listening on loopback? If it is, the vendor is serving and
#      only our address is wrong. No remedy is automatic — it is a config edit
#      or a DHCP reservation — so this says so every cycle and touches nothing.
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
# Overridable so the decision path can be exercised against a stub health
# endpoint and a unit nobody minds, rather than by breaking the real bus.
SERVICE="${SERVICE:-neo-dashboard}"
VENDOR="${VENDOR:-tistron_backend}"
STAMP="${TMPDIR:-/tmp}/neo-watchdog.state"
BUS_STAMP="${TMPDIR:-/tmp}/neo-watchdog-bus.state"

# Is something listening on this box, on that port? bash opens /dev/tcp itself,
# so this needs no netcat and no curl. `timeout` is used when it is there and
# skipped when it is not — a loopback connect fails at once if nothing listens,
# and depending on a coreutils binary to answer "is the house broken" is how a
# probe comes to report the wrong thing on a box that happens to lack it.
port_open() {
  local p="$1"
  [[ -n "$p" ]] || return 1
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null
  else
    ( exec 3<>"/dev/tcp/127.0.0.1/$p" ) 2>/dev/null
  fi
}

# Restarting the vendor's app is now reached from two directions — a silent bus,
# and a dead one — so it is written once. It is the only thing on this box that
# needs a sudoers line, and the failure to have one is said every time.
restart_vendor() {
  if sudo -n systemctl restart "$VENDOR" 2>/dev/null; then
    echo "$(date -Is) restarted $VENDOR" >&2
    return 0
  fi
  # Say it every time rather than once. This is the branch where the house is
  # broken and nothing can fix it automatically, so a line in the log each cycle
  # is the only thing that will ever get somebody's attention.
  echo "$(date -Is) cannot restart $VENDOR — no passwordless sudo." >&2
  echo "  add:  abneo ALL=(root) NOPASSWD: /bin/systemctl restart $VENDOR" >&2
  echo "  or by hand:  sudo systemctl restart $VENDOR" >&2
  return 1
}

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
  # Which thing to restart depends on WHY we are unhealthy, and until 2026-09-13
  # this branch never asked. ECONNREFUSED on the hub's own port means the host is
  # up and nothing is listening: the vendor's app is down, and restarting OURS is
  # provably useless — worse, this branch exits, so a 503 locked out the bus check
  # below and the vendor was never a candidate at all. Found after the vendor
  # crashed at boot on a DNS race and sat dead for five hours while the watchdog
  # dutifully restarted a dashboard that had nothing wrong with it.
  #
  # ECONNREFUSED and nothing else. EHOSTUNREACH or a timeout is the network or a
  # wedged box, where restarting the vendor is a guess; refused is not a guess.
  if [[ "$body" == *ECONNREFUSED* ]]; then
    # Refused says the host is up and nothing is listening. It does NOT say
    # WHICH host, and on 2026-09-17 it was a stranger that had taken the hub's
    # old lease. The address is in the error the dashboard reported, so take the
    # port out of it and ask whether the vendor is serving here, on this box.
    # Answering means the vendor is fine and our address is wrong.
    hub_addr=$(printf '%s' "$body" | grep -oE 'ECONNREFUSED [0-9.]+:[0-9]+' | head -1 | cut -d' ' -f2)
    hub_port="${hub_addr##*:}"
    # An unreadable error leaves this empty and we fall through to restarting the
    # vendor, which is the 2026-09-13 behaviour — the safe way to be wrong, since
    # that is the fault where the house really is down.
    if port_open "$hub_port"; then
      mine=$(hostname -I 2>/dev/null | tr -s ' ' ' ' | sed 's/ $//')
      echo "$(date -Is) health=$code, but $VENDOR IS serving on 127.0.0.1:$hub_port." >&2
      echo "  we are calling $hub_addr and this box holds: ${mine:-unknown}" >&2
      echo "  restarting nothing — a restart cannot fix an address. Fix one of:" >&2
      echo "    HUB_IP= in /etc/systemd/system/${SERVICE}.service (it beats config.json)" >&2
      echo "    hub_ip in ~/dashboard/config.json" >&2
      echo "    the DHCP reservation for this box on the router" >&2
      # The stamp is deliberately kept, so this is said on every cycle rather
      # than alternating with "first failure, waiting for confirmation".
      exit 0
    fi
    echo "$(date -Is) health=$code twice in a row, hub port refusing and nothing serving here — restarting $VENDOR" >&2
    restart_vendor
    rm -f "$STAMP"
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
if restart_vendor; then
  rm -f "$BUS_STAMP"
fi
