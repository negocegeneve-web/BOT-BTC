#!/usr/bin/env bash
# Chaîne de validation BOT-BTC — DOIT être verte avant tout push.
# Usage : bash scripts/validate.sh [original.js]
#   - Sans argument : syntaxe + boot test.
#   - Avec l'original en argument : ajoute le parity check SHA-256 par fonction.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/3 Syntaxe =="
node --check server.js
echo "OK"

if [ "${1:-}" != "" ]; then
  echo "== 2/3 Parity check (vs $1) =="
  python3 scripts/parity_check.py "$1" server.js
else
  echo "== 2/3 Parity check : SKIP (pas d'original fourni) =="
fi

echo "== 3/3 Boot test =="
if [ ! -d node_modules/ws ]; then npm install ws --silent >/dev/null 2>&1 || true; fi
node scripts/boot_test.js

echo ""
echo "VALIDATION : PASS — livraison/push autorisé."
