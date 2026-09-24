#!/usr/bin/env bash
# Deploy Statement Maker to the everysong VPS: code + the data files the server reads at boot, then a health check.
# Never touches data/state.json or data/floor.json on the server (live state).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=root@204.168.175.190
DIR=/root/statement-maker
node --check server.mjs && node --check public/app.js
rsync -az public server.mjs package.json package-lock.json "$HOST:$DIR/"
rsync -az scripts/evm.mjs "$HOST:$DIR/scripts/"
rsync -az data/credits.json data/traits.json data/rarity.json data/art.bytecode data/slips.bytecode "$HOST:$DIR/data/"
ssh "$HOST" "cd $DIR && npm ci --silent >/dev/null 2>&1; pm2 restart statement-maker --update-env >/dev/null
for i in \$(seq 1 24); do sleep 5; v=\$(curl -s 127.0.0.1:3061/api/version || true); if [ -n \"\$v\" ]; then echo \"up after \$((i*5))s: \$v\"; exit 0; fi; done
echo 'SERVER DID NOT COME UP'; pm2 logs statement-maker --lines 20 --nostream --err; exit 1"
curl -s -o /dev/null -w "public %{http_code}\n" https://statementmaker.204.168.175.190.nip.io/
