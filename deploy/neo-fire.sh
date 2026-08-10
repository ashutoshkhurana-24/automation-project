#!/usr/bin/env bash
# Fire a dashboard cue (or all-off) against the locally-running dashboard.
# This is what cron calls to give you schedules the hub itself can't run.
#
#   deploy/neo-fire.sh <cue-id>     e.g.  deploy/neo-fire.sh ashu-good-night
#   deploy/neo-fire.sh off          switches off everything that is on
#
# List cue ids any time with:  curl -s http://127.0.0.1:${PORT:-3000}/api/cues
set -euo pipefail

PORT="${PORT:-3000}"
KEY="${SHORTCUT_KEY:-}"
BASE="http://127.0.0.1:${PORT}"

arg="${1:-}"
if [[ -z "$arg" ]]; then
  echo "usage: neo-fire.sh <cue-id | off>" >&2
  exit 2
fi

if [[ "$arg" == "off" || "$arg" == "house-off" ]]; then
  URL="$BASE/api/house/off"
else
  URL="$BASE/api/cue/$arg/fire"
fi
[[ -n "$KEY" ]] && URL="$URL?key=$KEY"

# -f: fail on HTTP errors so cron logs a non-zero exit if the hub didn't answer.
curl -fsS -X POST "$URL"
echo
