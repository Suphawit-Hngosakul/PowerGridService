#!/bin/bash
set -e

# ─── ตรวจสอบ argument ─────────────────────────────────────────────────────────
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./setup.sh <db_password> <stub_service_url>"
  echo "Example: ./setup.sh Postgres123 https://xxxx.execute-api.us-east-1.amazonaws.com/prod"
  exit 1
fi

DB_PASSWORD="$1"
STUB_SERVICE_URL="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/main/infra"
SQL_FILE="$SCRIPT_DIR/main/sql/schema.sql"

if ! command -v tofu &>/dev/null; then
  echo "=== Installing OpenTofu ==="
  curl -fsSL https://get.opentofu.org/install-opentofu.sh | sudo bash -s -- --install-method rpm
fi

echo "=== [1/4] Terraform: init + apply ==="
cd "$INFRA_DIR"
tofu init -input=false
tofu apply -auto-approve \
  -var="db_password=$DB_PASSWORD" \
  -var="incident_service_url=$STUB_SERVICE_URL" \
  -var="driver_service_url=$STUB_SERVICE_URL" \
  -var="staff_service_url=$STUB_SERVICE_URL"

RDS_ENDPOINT=$(tofu output -raw rds_endpoint 2>/dev/null | grep -v '^\(╷\|│\|╵\)' | tr -d '[:space:]')
API_URL=$(tofu output -raw api_url 2>/dev/null | grep -v '^\(╷\|│\|╵\)' | tr -d '[:space:]')

if [ -z "$RDS_ENDPOINT" ] || [[ "$RDS_ENDPOINT" == *"Warning"* ]] || [[ "$RDS_ENDPOINT" == *"No outputs"* ]]; then
  echo ""
  echo "ERROR: ไม่สามารถดึง RDS endpoint จาก Terraform state ได้"
  echo "ลอง: cd main/infra && tofu output"
  exit 1
fi

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
echo "  RDS Endpoint     : $RDS_ENDPOINT"
echo "  API Base URL     : $API_URL"
echo "  Stub Service URL : $STUB_SERVICE_URL"
echo ""
echo "Endpoints:"
echo "  POST $API_URL/nodes/{node_id}/heartbeat        (fn1: detect outage)"
echo "  GET  $API_URL/nodes                             (fn2: get nodes)"
echo "  POST $API_URL/nodes/{node_id}/check-incident    (fn3: check incident)"
echo "  POST $API_URL/nodes/{node_id}/dispatch           (fn4: dispatch resources)"
echo "  POST $API_URL/nodes/{node_id}/reset              (demo: reset node)"
