#!/usr/bin/env bash
#
# Push server.js to the hub and restart it. Works from the LAN or from away.
#
#   bash deploy/push.sh                     # 192.168.1.3, the LAN address
#   bash deploy/push.sh 100.83.127.114      # the hub's tailnet address
#   NEO_HOST=100.83.127.114 bash deploy/push.sh
#
# Why this exists rather than the two scp lines in README-DEPLOY.md: those pin
# the LAN address, which is the one thing that does not work from away, and the
# whole point of the tailnet is deploying from away.
#
# It copies **server.js and nothing else**, deliberately. build-bundle.sh packs
# scenes.json, so a full bundle deploy overwrites the house's real cues with
# whatever local testing left behind — see CLAUDE.md. Every deploy this project
# has ever done was server.js alone; this keeps it that way by construction.

set -uo pipefail

HOST="${1:-${NEO_HOST:-192.168.1.3}}"
PORT="${NEO_PORT:-3000}"
DIR="${NEO_DIR:-dashboard}"
SVC="${NEO_SVC:-neo-dashboard}"
SSH="ssh -o ConnectTimeout=10 abneo@${HOST}"

cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

say "→ ${HOST}:${PORT}  (${DIR}, ${SVC})"

# --- preflight, on the Mac -------------------------------------------------
node --check server.js || die "server.js does not parse"

# node --check does NOT catch this one, which is why it is here: the frontend
# lives in a template literal, so an unescaped backtick anywhere inside it stays
# syntactically valid and takes the page down at runtime instead. It has shipped
# three times. Exactly two are expected — the ones opening and closing HTML.
ticks=$(python3 -c "
import io,re
s=io.open('server.js',encoding='utf-8').read()
print(len(re.findall(r'(?<!\\\\)\`', s[s.index('const HTML'):])))
") || die "could not run the backtick audit"
[ "$ticks" = "2" ] || die "$ticks unescaped backticks after 'const HTML' (expected 2) — the page would fail at runtime"

# And the page's own script, which is the half node --check cannot reach: it sees
# one big template literal, not the JavaScript inside it. A duplicate top-level
# declaration in there is a SyntaxError that leaves the server parsing perfectly,
# the page serving 200, and the whole app dead in the browser — which is exactly
# what shipped past both checks above on 2026-08-21 (a second offAfterWord). So
# the literal is pulled out, its ${...} holes are plugged, and it is parsed too.
page=$(mktemp -t neopage).js
python3 - "$page" <<'EXTRACT' || die "could not extract the page script"
import io, re, sys
s = io.open('server.js', encoding='utf-8').read()
body = re.search(r'<script>(.*)</script>', s[s.index('const HTML'):], re.S).group(1)
body = body.replace('\\`', '`').replace('\\$', '\x00').replace('\\\\', '\\')
out, i = [], 0
while i < len(body):                      # swap each ${ ... } for a literal
    if body[i:i+2] == '${':
        d, j = 1, i + 2
        while j < len(body) and d:
            if body[j] == '{': d += 1
            elif body[j] == '}': d -= 1
            j += 1
        out.append('null'); i = j
    else:
        out.append(body[i]); i += 1
io.open(sys.argv[1], 'w', encoding='utf-8').write(''.join(out).replace('\x00', '$'))
EXTRACT
node --check "$page" || { rm -f "$page"; die "the page's own script does not parse — it would serve 200 and be dead in the browser"; }
rm -f "$page"

say "  preflight ok (server parses, page script parses, $ticks backticks)"

# --- keep a way back ------------------------------------------------------
# A remote deploy that breaks startup leaves the house with no dashboard and
# nobody near the box, and the watchdog will restart a broken service for ever.
$SSH "cp ~/${DIR}/server.js ~/${DIR}/server.js.prev" || die "cannot reach ${HOST}"

# --- copy and restart ------------------------------------------------------
scp -q server.js "abneo@${HOST}:~/${DIR}/server.js" || die "copy failed"

$SSH "
  NODE=\$( [ -x /opt/nodejs/bin/node ] && echo /opt/nodejs/bin/node || echo node )
  \$NODE --check ~/${DIR}/server.js || exit 3
  sudo -n systemctl restart ${SVC} || exit 4
" || die "the hub refused it — nothing restarted, server.js.prev still holds the old one"

sleep 12

# --- did it actually come up? ---------------------------------------------
# curl already writes 000 into -w when it cannot connect, so this must not add
# a second one of its own — that is how a failure came out reading "page=000000".
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://${HOST}:${PORT}/" || true)
active=$($SSH "systemctl is-active ${SVC}" 2>/dev/null || echo unknown)

if [ "$code" = "200" ] && [ "$active" = "active" ]; then
  $SSH "curl -s -m 8 http://127.0.0.1:${PORT}/api/health -H 'Host: ${HOST}:${PORT}' | python3 -c \"
import json,sys
d=json.load(sys.stdin)
print('  devices', d['devices'], '| hub', d['hub']['ok'], '| cues', d.get('cues_fired','-'))
\"" 2>/dev/null
  say "deployed — service active, page 200"
  exit 0
fi

say "page=${code} service=${active} — rolling back"
$SSH "cp ~/${DIR}/server.js.prev ~/${DIR}/server.js && sudo -n systemctl restart ${SVC}" \
  || die "ROLLBACK FAILED — the dashboard is down and needs hands on the box"
sleep 10
back=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://${HOST}:${PORT}/" || true)
die "rolled back to the previous server.js (page now ${back}) — the change was not deployed"
