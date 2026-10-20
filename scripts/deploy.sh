#!/usr/bin/env bash
# Deploys the counter to the Hetzner machine (ssh host "hetzner"): copies the code and runs deploy/install.sh
# there. Usage: npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${COUNTER_HOST:-hetzner}"

npm run -s check
rsync -az --delete --include='src/***' --include='deploy/***' --include='projects.json' --include='package.json' --exclude='*' \
  ./ "$HOST:/opt/counter/"
ssh "$HOST" 'bash /opt/counter/deploy/install.sh'

echo "==> From outside"
curl -fsS --max-time 15 https://188.245.182.47/c/health && echo
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://188.245.182.47/stats/)"
echo "/stats/ without a password: $code"
[ "$code" = 401 ] || [ "$code" = 403 ] || { echo "!!! /stats/ must not open without a password"; exit 1; }
