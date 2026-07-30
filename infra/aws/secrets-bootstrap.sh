#!/usr/bin/env bash
# Moves COCKROACHDB_URL and ALLOWED_ORIGIN out of the ECS task definition's
# plaintext environment and into one Secrets Manager secret, then grants the
# ECS *execution* role permission to read it.
#
# Execution role, not task role: ECS resolves `secrets` entries before the
# container starts, using the execution role — the task role only covers what
# the running app calls itself (Polly, S3).
#
# Why bother: the database URL currently ships as a plain environment variable,
# which means it is readable by anyone who can describe the service in the ECS
# console, and it appears in any deploy log that dumps the task definition.
# This also lets CI roll the service without ever handling the value.
#
# Requires: aws CLI configured, jq. Run once locally; idempotent, and safe to
# re-run after rotating the database password.
#
# Usage:
#   ./infra/aws/secrets-bootstrap.sh
#
# Reads values with the same precedence as ecs-deploy.sh:
#   shell-exported > infra/aws/.env.production > root .env

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-west-2}"
SECRET_ID="${SECRET_ID:-book-holder/api}"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-ecsTaskExecutionRole}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROD_ENV_FILE="$REPO_ROOT/infra/aws/.env.production"

# Same single-key reader as ecs-deploy.sh, and for the same reason — sourcing
# the file would drag the local-dev IAM user's keys into this shell and
# override the `aws login` session every call here depends on.
read_env_var() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^${key}=" "$file" | tail -1)"
  value="${line#*=}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s' "$value"
}

resolve_var() {
  local key="$1" val
  val="${!key:-}"
  [ -n "$val" ] && { printf '%s' "$val"; return; }
  val="$(read_env_var "$key" "$PROD_ENV_FILE")"
  [ -n "$val" ] && { printf '%s' "$val"; return; }
  read_env_var "$key" "$REPO_ROOT/.env"
}

COCKROACHDB_URL="$(resolve_var COCKROACHDB_URL)"
ALLOWED_ORIGIN="$(resolve_var ALLOWED_ORIGIN)"

: "${COCKROACHDB_URL:?COCKROACHDB_URL is blank/missing — set it before running}"
: "${ALLOWED_ORIGIN:?ALLOWED_ORIGIN is blank/missing — set it in infra/aws/.env.production}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "== Account $ACCOUNT_ID, region $AWS_REGION, secret '$SECRET_ID' =="

# --argjson would re-parse the URL; --arg keeps both values as opaque strings.
SECRET_JSON="$(jq -n \
  --arg db "$COCKROACHDB_URL" \
  --arg origin "$ALLOWED_ORIGIN" \
  '{COCKROACHDB_URL: $db, ALLOWED_ORIGIN: $origin}')"

if aws secretsmanager describe-secret --region "$AWS_REGION" --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  echo "Secret exists — storing a new version."
  aws secretsmanager put-secret-value --region "$AWS_REGION" \
    --secret-id "$SECRET_ID" --secret-string "$SECRET_JSON" >/dev/null
else
  echo "Creating secret '$SECRET_ID'..."
  aws secretsmanager create-secret --region "$AWS_REGION" \
    --name "$SECRET_ID" \
    --description "Runtime config for the Book Holder API (ECS Express Mode)." \
    --secret-string "$SECRET_JSON" >/dev/null
fi

SECRET_ARN="$(aws secretsmanager describe-secret --region "$AWS_REGION" \
  --secret-id "$SECRET_ID" --query ARN --output text)"

# Scoped to this one secret. put-role-policy overwrites, so re-running after a
# rotation keeps this correct.
aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name "ReadBookHolderApiSecret" \
  --policy-document "$(jq -n --arg arn "$SECRET_ARN" \
    '{Version: "2012-10-17", Statement: [
       {Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: $arn}]}')" >/dev/null

echo
echo "Done. Secret ARN:"
echo "    $SECRET_ARN"
echo
echo "Execution role '$EXEC_ROLE_NAME' can now read it at container start."
echo "Next: run ./infra/aws/ecs-deploy.sh once so the service picks up the"
echo "secrets-based task definition, after which CI keeps it that way."
