#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f infra/terraform.tfvars ]; then
  echo "Error: infra/terraform.tfvars not found." >&2
  echo "  Create it with all of:" >&2
  echo "    db_password                  = \"...\"" >&2
  echo "    subnet_ids                   = [\"subnet-aaa\",\"subnet-bbb\"]" >&2
  echo "    lambda_security_group_id     = \"sg-...\"" >&2
  echo "    incident_impact_zone_url     = \"https://.../impact-zones/active\"" >&2
  echo "    priority_case_service_url    = \"https://.../v1/report\"" >&2
  echo "    outbound_shared_secret       = \"...\"" >&2
  echo "    resource_completed_queue_arn = \"arn:aws:sqs:us-east-1:.../resource-events-powergrid-completed\"" >&2
  exit 1
fi

echo "→ [1/5] Build Lambda packages"
npm run build

echo
echo "→ [2/5] tofu init"
(cd infra && tofu init -input=false -upgrade)

echo
echo "→ [3/5] tofu apply"
(cd infra && tofu apply -auto-approve -input=false)

echo
echo "→ [4/5] Run DB migrations"
DATABASE_URL="$(cd infra && tofu output -raw database_url)" npm run migrate

echo
echo "→ [5/5] Deploy web to S3"
bash scripts/deploy-web.sh

echo
echo "✓ Deployed successfully."
echo
echo "Endpoints / IDs:"
echo "  RDS endpoint:        $(cd infra && tofu output -raw rds_endpoint)"
echo "  SNS status topic:    $(cd infra && tofu output -raw sns_status_topic_arn)"
echo "  SNS outage topic:    $(cd infra && tofu output -raw sns_outage_topic_arn)"
echo "  API endpoint:        $(cd infra && tofu output -raw api_endpoint)"
echo "  Web URL:             $(cd infra && tofu output -raw web_url)"
echo
echo "Lambda functions:"
(cd infra && tofu output -json lambdas | jq -r 'to_entries[] | "  • " + .value')
