#!/usr/bin/env bash
# Statement Maker deploys on Vercel from git: pushing main deploys production (project statement-maker,
# team yuri-rybaks-projects). This script just pushes and checks the live site.
set -euo pipefail
cd "$(dirname "$0")/.."
node --check lib/core.mjs && node --check public/app.js
git push -q
sleep 45
curl -s -o /dev/null -w "site %{http_code}\n" https://statement-maker.vercel.app/
curl -s https://statement-maker.vercel.app/api/version; echo
