#!/usr/bin/env bash
# Creates an AWS Budget with email alerts at 80% and 100% of actual monthly
# spend — a cost safety net for this out-of-pocket build, per README.md /
# docs/BE_PLAN.md §4. Idempotent: skips creation if the budget already exists.
#
# Usage:
#   BUDGET_ALERT_EMAIL=you@example.com ./infra/aws/budget-alert.sh
#
# Optional overrides:
#   BUDGET_NAME=book-holder-monthly   (default)
#   BUDGET_AMOUNT_USD=25              (default)

set -euo pipefail

: "${BUDGET_ALERT_EMAIL:?Set BUDGET_ALERT_EMAIL to the notification address, e.g. BUDGET_ALERT_EMAIL=you@example.com ./infra/aws/budget-alert.sh}"
BUDGET_NAME="${BUDGET_NAME:-book-holder-monthly}"
BUDGET_AMOUNT_USD="${BUDGET_AMOUNT_USD:-25}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

if aws budgets describe-budget \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
  echo "Budget '$BUDGET_NAME' already exists for account $ACCOUNT_ID — skipping."
  exit 0
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/budget.json" <<EOF
{
  "BudgetName": "$BUDGET_NAME",
  "BudgetLimit": { "Amount": "$BUDGET_AMOUNT_USD", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
EOF

cat > "$WORKDIR/notifications.json" <<EOF
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "$BUDGET_ALERT_EMAIL" }
    ]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "$BUDGET_ALERT_EMAIL" }
    ]
  }
]
EOF

aws budgets create-budget \
  --account-id "$ACCOUNT_ID" \
  --budget "file://$WORKDIR/budget.json" \
  --notifications-with-subscribers "file://$WORKDIR/notifications.json"

echo "Created budget '$BUDGET_NAME' — \$$BUDGET_AMOUNT_USD/month, alerts to $BUDGET_ALERT_EMAIL at 80% and 100% actual spend."
