#!/usr/bin/env bash

set -euo pipefail

SID="AllowExternalSubscribers"
ACTIONS='["SNS:Subscribe","SNS:Receive","SNS:GetTopicAttributes","SNS:ListSubscriptionsByTopic"]'

# ── resolve topic ARN ────────────────────────────────────────────────
TOPIC_ARN="${POWERGRID_STATUS_TOPIC_ARN:-}"
if [ -z "$TOPIC_ARN" ] && [ -d infra ]; then
  TOPIC_ARN=$(cd infra && (tofu output -raw sns_status_topic_arn 2>/dev/null \
                        || terraform output -raw sns_status_topic_arn 2>/dev/null)) || true
fi
if [ -z "$TOPIC_ARN" ]; then
  echo "Error: cannot find topic ARN." >&2
  echo "  Set POWERGRID_STATUS_TOPIC_ARN, or run from repo root after deploy." >&2
  exit 1
fi

REGION=$(echo "$TOPIC_ARN" | cut -d: -f4)

# ── parse args ───────────────────────────────────────────────────────
cmd="${1:-}"
arg="${2:-}"

usage() {
  cat <<EOF
Usage:
  $0 list
  $0 add    <12-digit-account-id>
  $0 remove <12-digit-account-id>
EOF
  exit 2
}

case "$cmd" in
  list) ;;
  add|remove)
    [ -n "$arg" ] || usage
    [[ "$arg" =~ ^[0-9]{12}$ ]] || { echo "account id must be 12 digits" >&2; exit 2; }
    ;;
  *) usage ;;
esac

# ── read current policy ──────────────────────────────────────────────
current_policy=$(aws sns get-topic-attributes \
  --region "$REGION" \
  --topic-arn "$TOPIC_ARN" \
  --query 'Attributes.Policy' --output text)

if [ -z "$current_policy" ] || [ "$current_policy" = "None" ]; then
  current_policy='{"Version":"2012-10-17","Statement":[]}'
fi

# Extract current subscribers from the AllowExternalSubscribers statement
current_ids=$(jq -r --arg sid "$SID" '
  (.Statement // [])
  | map(select(.Sid == $sid))
  | first
  | (.Principal.AWS // [])
  | (if type == "string" then [.] else . end)
  | map(sub("^arn:aws:iam::"; "") | sub(":root$"; ""))
  | .[]?
' <<< "$current_policy")

# ── command dispatch ─────────────────────────────────────────────────
case "$cmd" in
  list)
    echo "Topic:    $TOPIC_ARN"
    if [ -z "$current_ids" ]; then
      echo "Subscribers: (none)"
    else
      echo "Subscribers:"
      printf '%s\n' "$current_ids" | sed 's/^/  - /'
    fi
    exit 0
    ;;
  add)
    if printf '%s\n' "$current_ids" | grep -qx "$arg"; then
      echo "$arg is already a subscriber — no change"; exit 0
    fi
    next_ids=$(printf '%s\n%s\n' "$current_ids" "$arg" | grep -v '^$' | sort -u)
    ;;
  remove)
    if ! printf '%s\n' "$current_ids" | grep -qx "$arg"; then
      echo "$arg is not a subscriber — no change"; exit 0
    fi
    next_ids=$(printf '%s\n' "$current_ids" | grep -vx "$arg" || true)
    ;;
esac

# ── build new policy ─────────────────────────────────────────────────
if [ -z "$next_ids" ]; then
  # No subscribers left — drop the SID statement entirely
  new_policy=$(jq --arg sid "$SID" '
    .Statement |= map(select(.Sid != $sid))
  ' <<< "$current_policy")
else
  principal_arns=$(printf '%s\n' "$next_ids" \
    | jq -R . \
    | jq -s 'map("arn:aws:iam::" + . + ":root")')
  new_policy=$(jq --arg sid "$SID" \
                  --arg arn "$TOPIC_ARN" \
                  --argjson principals "$principal_arns" \
                  --argjson actions "$ACTIONS" '
    .Statement |= ((map(select(.Sid != $sid))) + [{
      Sid: $sid,
      Effect: "Allow",
      Principal: { AWS: $principals },
      Action: $actions,
      Resource: $arn
    }])
  ' <<< "$current_policy")
fi

# ── write back ───────────────────────────────────────────────────────
aws sns set-topic-attributes \
  --region "$REGION" \
  --topic-arn "$TOPIC_ARN" \
  --attribute-name Policy \
  --attribute-value "$new_policy" >/dev/null

echo "OK. Subscribers now:"
if [ -z "$next_ids" ]; then
  echo "  (none)"
else
  printf '%s\n' "$next_ids" | sed 's/^/  - /'
fi
