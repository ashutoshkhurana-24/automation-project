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
#
# The one exception is config.json, and only when the box does not have one.
# It is per-install — the house's name, its hub, its televisions, its groups —
# and the console edits it in place, so overwriting it from here would push one
# house's settings onto another. But server.js now *reads* it, and a box without
# one comes up as "The House" with no televisions and no group tiles at all. So:
# placed if missing, never touched if present.

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

# And every OTHER page in the file, which is now the setup console. The check
# above finds the one script after `const HTML` and stops; SETUP_HTML is declared
# earlier, so a fatal error in it sailed through a green preflight and was
# actually deployed once — /setup served 200 with a script that never ran, which
# is the exact failure mode this whole section exists to catch. So: every
# <script> in the file, not just the dashboard's.
scripts=$(python3 - <<'ALL' || die "could not extract the page scripts"
import io, re, sys, os, tempfile
s = io.open('server.js', encoding='utf-8').read()
paths = []
for n, body in enumerate(re.findall(r'<script>(.*?)</script>', s, re.S)):
    body = body.replace('\\`', '`').replace('\\$', '\x00').replace('\\\\', '\\')
    out, i = [], 0
    while i < len(body):                      # plug the ${...} holes
        if body[i:i+2] == '${':
            d, j = 1, i + 2
            while j < len(body) and d:
                if body[j] == '{': d += 1
                elif body[j] == '}': d -= 1
                j += 1
            out.append('null'); i = j
        else:
            out.append(body[i]); i += 1
    p = os.path.join(tempfile.gettempdir(), 'neoscript%d.js' % n)
    io.open(p, 'w', encoding='utf-8').write(''.join(out).replace('\x00', '$'))
    paths.append(p)
print('\n'.join(paths))
ALL
)
n=0
for f in $scripts; do
  n=$((n+1))
  node --check "$f" || { die "page script $n does not parse — it would serve 200 and be dead in the browser"; }
done
rm -f $scripts
say "  $n page scripts parse"

say "  preflight ok (server parses, page script parses, $ticks backticks)"

# --- keep a way back ------------------------------------------------------
# A remote deploy that breaks startup leaves the house with no dashboard and
# nobody near the box, and the watchdog will restart a broken service for ever.
$SSH "cp ~/${DIR}/server.js ~/${DIR}/server.js.prev" || die "cannot reach ${HOST}"

# config.json: place it only if the box has none. Never overwrite — see above.
if $SSH "test -f ~/${DIR}/config.json"; then
  say "  config.json already there, left alone"
else
  [ -f config.json ] || die "this box has no config.json and neither do you — run tools/setup.js first"
  scp -q config.json "abneo@${HOST}:~/${DIR}/config.json" || die "could not place config.json"
  say "  config.json placed (first time)"
fi

# --- copy and restart ------------------------------------------------------
scp -q server.js "abneo@${HOST}:~/${DIR}/server.js" || die "copy failed"

$SSH "
  # /opt/nodejs is where the first install put it; \$HOME/nodejs is a per-user
  # install, which needs no root and is what the second house has. Bare node
  # last, for a box where it is on PATH.
  for c in /opt/nodejs/bin/node \$HOME/nodejs/bin/node \$(command -v node); do
    [ -x \"\$c\" ] && NODE=\$c && break
  done
  [ -n \"\${NODE:-}\" ] || { echo 'no node on the box'; exit 5; }
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
print('  devices', d['devices'], '| hub', d['hub']['ok'], '| cues fired', d.get('cues_fired','-'))
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
