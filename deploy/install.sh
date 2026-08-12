#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install the Neo Console Dashboard as a systemd service ON the hub (the NAS).
#
# Run this ON the hub, from inside the unpacked bundle directory:
#     cd ~/dashboard && bash deploy/install.sh
#
# It installs exactly ONE service (neo-dashboard), in ONE directory, on a
# non-8090 port. It never modifies anything the vendor owns. Re-running it is
# safe — it just updates the unit and restarts.
# ---------------------------------------------------------------------------
set -euo pipefail

SERVICE=neo-dashboard
PORT="${PORT:-3000}"

# The app dir is the parent of this deploy/ folder (i.e. where server.js lives).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"

echo "== Neo Console Dashboard installer =="
echo "   app dir : $APP_DIR"
echo "   user    : $RUN_USER"
echo "   port    : $PORT"

# --- 1. sanity: this really is the app dir ---------------------------------
if [[ ! -f "$APP_DIR/server.js" ]]; then
  echo "!! server.js not found in $APP_DIR — run this from inside the bundle." >&2
  exit 1
fi

# --- 2. find a usable Node (>= 14) -----------------------------------------
# Prefer an explicit NODE_BIN, then a standalone /opt/nodejs (installed alongside
# a too-old system node without disturbing it), then whatever's on PATH.
if [[ -z "${NODE_BIN:-}" ]]; then
  if [[ -x /opt/nodejs/bin/node ]]; then NODE_BIN=/opt/nodejs/bin/node
  else NODE_BIN="$(command -v node || true)"; fi
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "!! Node.js is not installed on this box." >&2
  echo "   If the hub has internet:  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  echo "   If it does NOT:           copy a Node 18 linux tarball for this CPU into ~/ and add its bin/ to PATH, then re-run." >&2
  echo "   CPU arch here is: $(uname -m)" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 14 )); then
  echo "!! Node $("$NODE_BIN" -v) is too old (need >= 14). Install a newer Node and re-run." >&2
  exit 1
fi
echo "   node    : $NODE_BIN ($("$NODE_BIN" -v))"

# --- 3. dependencies (bundled node_modules means this is usually a no-op) ----
if [[ ! -d "$APP_DIR/node_modules/express" || ! -d "$APP_DIR/node_modules/ws" ]]; then
  echo ".. node_modules missing; running npm install --omit=dev"
  ( cd "$APP_DIR" && npm install --omit=dev )
fi

# --- 4. syntax check before we wire anything up -----------------------------
"$NODE_BIN" --check "$APP_DIR/server.js"
echo "   server.js syntax OK"

# --- 5. render the unit file from the template ------------------------------
UNIT_SRC="$APP_DIR/deploy/dashboard.service"
UNIT_TMP="$(mktemp)"
sed -e "s|__USER__|$RUN_USER|" \
    -e "s|__APP_DIR__|$APP_DIR|" \
    -e "s|__NODE_BIN__|$NODE_BIN|" \
    -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
    "$UNIT_SRC" > "$UNIT_TMP"

# --- 6. install as a system service (needs sudo) or fall back to --user -----
if sudo -n true 2>/dev/null || sudo -v 2>/dev/null; then
  echo ".. installing system service (survives reboot automatically)"
  sudo cp "$UNIT_TMP" "/etc/systemd/system/$SERVICE.service"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"
  sleep 1
  sudo systemctl --no-pager --full status "$SERVICE" | head -12 || true
  CTL="sudo systemctl"
else
  echo ".. no sudo — installing as a per-user service instead"
  mkdir -p "$HOME/.config/systemd/user"
  cp "$UNIT_TMP" "$HOME/.config/systemd/user/$SERVICE.service"
  # a user service only runs while you're logged in unless lingering is on:
  loginctl enable-linger "$RUN_USER" 2>/dev/null \
    || echo "   (could not enable linger — ask an admin to run: sudo loginctl enable-linger $RUN_USER)"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  sleep 1
  systemctl --user --no-pager --full status "$SERVICE" | head -12 || true
  CTL="systemctl --user"
fi
rm -f "$UNIT_TMP"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "== done =="
echo "   Dashboard:  http://${IP:-<hub-ip>}:$PORT"
echo "   Logs:       $CTL status $SERVICE   ·   journalctl -u $SERVICE -f"
echo "   Schedules:  see deploy/README-DEPLOY.md — add cron lines calling deploy/neo-fire.sh"
echo "   Point your iPhone shortcuts at http://${IP:-<hub-ip>}:$PORT instead of the Mac."
