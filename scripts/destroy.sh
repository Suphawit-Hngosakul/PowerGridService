#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--yes" ]; then
  ans="destroy"
else
  echo "About to DESTROY all PowerGrid AWS resources (RDS, Lambdas, SNS, SQS, IoT rule)."
  read -rp 'Type "destroy" to confirm: ' ans
fi

[ "$ans" = "destroy" ] || { echo "aborted."; exit 1; }

echo
echo "→ tofu destroy"
(cd infra && tofu destroy -auto-approve -input=false)

echo
echo "✓ All managed resources destroyed."
echo "  Note: CloudWatch Log Groups (/aws/lambda/powergrid-*) are NOT auto-deleted."
echo "  Clean them up via Console if you want a totally fresh slate."
