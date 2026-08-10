#!/usr/bin/env bash
# Build the deployable bundle for hosting the dashboard on the hub (the NAS).
# Run on the Mac:  ./build-bundle.sh   ->   dashboard-nas-bundle.tar.gz
# See deploy/README-DEPLOY.md for what to do with it.
set -euo pipefail
cd "$(dirname "$0")"

OUT=dashboard-nas-bundle.tar.gz

# node_modules is bundled on purpose: express + ws are pure-JS, so the hub can
# install offline. scenes.json carries your cues. .git and scratch are excluded.
node --check server.js

tar --disable-copyfile \
    --exclude='.DS_Store' \
    -czf "$OUT" \
    server.js \
    package.json \
    package-lock.json \
    data \
    scenes.json \
    node_modules \
    deploy

echo "built $OUT ($(du -h "$OUT" | cut -f1)) — see deploy/README-DEPLOY.md"
