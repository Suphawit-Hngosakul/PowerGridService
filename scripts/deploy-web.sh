#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Read terraform outputs"
API_URL="$(cd infra && tofu output -raw api_endpoint)"
BUCKET="$(cd infra && tofu output -raw web_bucket)"
WEB_URL="$(cd infra && tofu output -raw web_url)"

echo "  API:    $API_URL"
echo "  Bucket: $BUCKET"

echo
echo "→ Generate web/config.js"
cat > web/config.js <<EOF
window.APP_CONFIG = { apiUrl: '$API_URL' };
EOF

echo
echo "→ Upload index.html (cacheable)"
aws s3 cp web/index.html "s3://$BUCKET/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "max-age=3600"

echo
echo "→ Upload config.js (no-cache)"
aws s3 cp web/config.js "s3://$BUCKET/config.js" \
  --content-type "application/javascript; charset=utf-8" \
  --cache-control "no-cache, no-store, must-revalidate"

echo
echo "✓ Web deployed."
echo "  $WEB_URL"
