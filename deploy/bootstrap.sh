#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# First run, on a hub that has never had this dashboard.
#
#   bash deploy/bootstrap.sh                  # look at everything, change nothing
#   bash deploy/bootstrap.sh --hub 192.168.1.9
#   bash deploy/bootstrap.sh --go             # actually install
#
# Four steps, in this order, because each one needs the last:
#   1. a Node new enough to run the app, without touching the system one
#   2. its two dependencies
#   3. a look at the hub, and a config.json written from what is there
#   4. the systemd service
#
# It is a dry run until --go. The first thing anybody wants against a strange
# house is "what would this do", and the second is "what did it find" — neither
# of which should require having already installed anything.
#
# Node rather than Bun, deliberately: Bun's ordinary Linux build wants AVX2 and
# this script is aimed at somebody else's box. The same desktop model that runs
# the hub here shipped with a Pentium that lacks it, and the app's one real
# dependency is a WebSocket with permessage-deflate, which is the single most
# fragile thing in the whole system. The standalone Node tarball runs anywhere.
# ---------------------------------------------------------------------------
set -uo pipefail

NODE_VERSION="${NODE_VERSION:-18.20.4}"
NODE_PREFIX="${NODE_PREFIX:-/opt/nodejs}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GO=0
HUB=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --go) GO=1; shift ;;
    --hub) HUB="${2:-}"; shift 2 ;;
    --node-version) NODE_VERSION="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
would() { if (( GO )); then return 1; else return 0; fi }

say "Neo Console Dashboard — first run"
say "  app dir  : $APP_DIR"
say "  arch     : $(uname -m)"
(( GO )) || say "  DRY RUN — nothing will be changed. Add --go when it looks right."

[[ -f "$APP_DIR/server.js" ]] || die "server.js is not in $APP_DIR — run this from inside the unpacked app."

# --- 1. Node ---------------------------------------------------------------
step "Node"
NODE_BIN=""
if [[ -x "$NODE_PREFIX/bin/node" ]]; then NODE_BIN="$NODE_PREFIX/bin/node"
elif command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi

NEED_NODE=1
if [[ -n "$NODE_BIN" ]]; then
  HAVE="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  say "  found $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo '?'))"
  if (( HAVE >= 14 )); then NEED_NODE=0
  else say "  too old — the app needs 14 or newer"; fi
fi

if (( NEED_NODE )); then
  # Which tarball. The hub here is x86-64; an ARM box (a Pi, say) needs the
  # other one, and anything else has no prebuilt Node at all.
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=linux-x64 ;;
    aarch64|arm64) NODE_ARCH=linux-arm64 ;;
    armv7l) NODE_ARCH=linux-armv7l ;;
    *) die "no prebuilt Node for $(uname -m) — install one by hand and re-run" ;;
  esac
  URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  say "  would install Node $NODE_VERSION ($NODE_ARCH) into $NODE_PREFIX"
  say "  from $URL"
  say "  the system's own node is left exactly as it is — something on this box"
  say "  may depend on it, and on the hub here the vendor's app does"
  if would; then
    say "  (dry run)"
  else
    command -v curl >/dev/null 2>&1 || die "curl is not installed, so Node cannot be fetched"
    TMP="$(mktemp -d)"
    say "  downloading..."
    curl -fsSL "$URL" -o "$TMP/node.tar.xz" || die "could not download Node — is this box online?"
    sudo mkdir -p "$NODE_PREFIX" || die "cannot create $NODE_PREFIX (sudo needed)"
    sudo tar -xJf "$TMP/node.tar.xz" -C "$NODE_PREFIX" --strip-components=1 || die "could not unpack Node"
    rm -rf "$TMP"
    NODE_BIN="$NODE_PREFIX/bin/node"
    [[ -x "$NODE_BIN" ]] || die "unpacked, but $NODE_BIN is not there"
    say "  installed $("$NODE_BIN" -v)"
  fi
fi

# --- 2. dependencies -------------------------------------------------------
step "Dependencies"
if [[ -d "$APP_DIR/node_modules/express" && -d "$APP_DIR/node_modules/ws" ]]; then
  say "  express and ws are already here"
else
  say "  would run: npm install --omit=dev"
  if ! would; then
    NPM_BIN="$(dirname "$NODE_BIN")/npm"
    [[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm || true)"
    [[ -n "$NPM_BIN" ]] || die "npm not found next to $NODE_BIN"
    ( cd "$APP_DIR" && "$NPM_BIN" install --omit=dev ) || die "npm install failed"
  fi
fi

# --- 3. the hub, and a config written from it ------------------------------
step "The hub"
if [[ -f "$APP_DIR/config.json" ]] && (( ! GO )); then
  say "  config.json already exists — setup would keep its name, groups,"
  say "  screens and kind overrides and only refresh the device list."
fi
SETUP_ARGS=()
[[ -n "$HUB" ]] && SETUP_ARGS+=(--hub "$HUB")
if (( GO )); then SETUP_ARGS+=(--apply); fi

if [[ -z "$NODE_BIN" ]]; then
  say "  skipped: no Node yet, so the hub cannot be read. Re-run with --go."
else
  # ${a[@]+"${a[@]}"} rather than "${a[@]}": with set -u an empty array is an
  # unbound variable on bash 3.2, which is what macOS ships. The hub runs bash 5
  # and would not have cared, which is exactly how that ships unnoticed.
  "$NODE_BIN" "$APP_DIR/tools/setup.js" ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} \
    || die "could not read the hub"
fi

# --- 4. the service --------------------------------------------------------
step "The service"
if would; then
  say "  would run: bash deploy/install.sh"
  say "  one service, one directory, on a port that is not the vendor's 8090."
  say "  Nothing the vendor owns is touched."
  say
  say "Dry run over. Nothing was changed. Run again with --go to do it."
  exit 0
fi
NODE_BIN="$NODE_BIN" bash "$APP_DIR/deploy/install.sh" || die "install.sh failed"

PORT_NOW="$("$NODE_BIN" -p "try{require('$APP_DIR/config.json').port||3000}catch(e){3000}")"
say
say "Done. Two things left, both in a browser:"
say "  http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT_NOW}/setup"
say "    — name the house, say which fittings form a group, and map each"
say "      screen to the room it is actually in."
say "  http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT_NOW}/"
say "    — the dashboard itself."
