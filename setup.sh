#!/bin/bash
set -e

# ─── ตรวจสอบ argument ─────────────────────────────────────────────────────────
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./setup.sh <db_password> <incident_service_url>"
  echo "Example: ./setup.sh Postgres123 https://xxxx.execute-api.us-east-1.amazonaws.com/prod"
  exit 1
fi

DB_PASSWORD="$1"
INCIDENT_SERVICE_URL="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/main/infra"
SQL_FILE="$SCRIPT_DIR/main/sql/schema.sql"

echo "=== [1/4] Terraform: init + apply ==="
cd "$INFRA_DIR"
tofu init -input=false
tofu apply -auto-approve \
  -var="db_password=$DB_PASSWORD" \
  -var="incident_service_url=$INCIDENT_SERVICE_URL"

RDS_ENDPOINT=$(tofu output -raw rds_endpoint)
API_URL=$(tofu output -raw api_url)

echo ""
echo "=== [2/4] Install PostgreSQL client ==="
if ! command -v psql &>/dev/null; then
  sudo dnf install -y postgresql15
fi

echo ""
echo "=== [3/4] Apply database schema ==="
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d powergrid \
  -f "$SQL_FILE"

echo ""
echo "=== [4/4] Setup complete ==="
echo ""
echo "  RDS Endpoint : $RDS_ENDPOINT"
echo "  API Base URL : $API_URL"
echo ""
echo "Endpoints:"
echo "  POST $API_URL/nodes/{node_id}/heartbeat"
echo "  GET  $API_URL/nodes"
echo "  POST $API_URL/nodes/{node_id}/check-incident"
