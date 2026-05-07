#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

YES_FLAG="${1:-}"

echo "→ Step 1/2: destroy current deployment"
"$ROOT/scripts/destroy.sh" $YES_FLAG

echo
echo "→ Step 2/2: re-deploy from scratch"
"$ROOT/scripts/deploy.sh"
