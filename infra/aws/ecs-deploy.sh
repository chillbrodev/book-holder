#!/usr/bin/env bash
# Builds api/Dockerfile, pushes it to ECR, and creates (or updates) an ECS
# Express Mode service to run it — AWS's recommended App Runner replacement
# (App Runner stopped accepting new customers 2026-04-30, see
# docs/PROJECT_PLAN.md §9 / docs/BE_PLAN.md §4). Idempotent: re-running
# updates the existing service in place instead of erroring, same pattern as
# budget-alert.sh.
#
# Requires: docker, jq, aws CLI configured (see infra/aws/README.md — `aws login`).
#
# NOTE: wires up AWS_REGION, POLLY_CACHE_BUCKET, POLLY_DEFAULT_VOICE_ID (if
# exported — per-character voices live in characters.polly_voice_id, not an
# env var), BEDROCK_MODEL_ID_COMPARISON (if exported), DENO_ENV=production,
# and COCKROACHDB_URL/ALLOWED_ORIGIN (see COCKROACHDB_URL/ALLOWED_ORIGIN below
# for where these are read from).
#
# BEDROCK_MODEL_ID_COMPARISON is passed only when set, because
# configClient.ts carries a working default (the Nova Micro geo profile). The
# env var exists to change models without a code deploy — which is the whole
# reason it is plumbed rather than left hardcoded. Note this is the *bootstrap*
# path; the real deploy is .github/workflows/deploy-api.yml, which reads the
# same override from a GitHub repository variable.
#
# BEDROCK_MODEL_ID_SUMMARY/S3_RECORDINGS_BUCKET are still NOT passed — nothing
# reads them yet (the coaching-note and S3-recordings work isn't built), so
# there's nothing to wire up until that exists.
#
# Usage:
#   ./infra/aws/ecs-deploy.sh
#
# Optional overrides (precedence: shell-exported > infra/aws/.env.production
# [gitignored — deploy-only values, e.g. ALLOWED_ORIGIN, that never need
# toggling for local dev] > root .env):
#   COCKROACHDB_URL=...                                 (default: read from .env.production, then the root .env)
#   ALLOWED_ORIGIN=https://your-deployed-frontend.example (default: read from .env.production, then the root
#                                                          .env — must be the real deployed frontend's
#                                                          origin, not localhost, or CORS blocks it)
#   AWS_REGION=us-west-2                              (default)
#   ECR_REPO_NAME=book-holder-api                      (default)
#   SERVICE_NAME=book-holder-api                        (default)
#   ECS_CPU=256                                          (default — CPU *units*, not vCPUs: 256 = .25 vCPU.
#                                                         Confirmed via `aws ecs create-express-gateway-service
#                                                         help` — a bare "0.25" 400s with InvalidParameterException.)
#   ECS_MEMORY=512                                        (default — MiB, not GB, same help output)
#   CONTAINER_PORT=8000                                 (default — must match api/main.ts's PORT fallback)
#   HEALTH_CHECK_PATH=/                                 (default)
#   EXEC_ROLE_NAME=ecsTaskExecutionRole                 (default, AWS's suggested name)
#   INFRA_ROLE_NAME=ecsInfrastructureRoleForExpressServices  (default, AWS's suggested name)
#   TASK_ROLE_NAME=book-holder-api-task-role             (default — app-level permissions the
#                                                          running container needs, e.g. Polly/S3;
#                                                          distinct from EXEC_ROLE_NAME, which only
#                                                          covers image pull + logs)
#   POLLY_CACHE_BUCKET_NAME=book-holder-polly-cache-<account-id>  (default — S3 bucket names are
#                                                                   globally unique, so the account ID
#                                                                   is appended; override if you already
#                                                                   have a bucket you want to reuse)

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-west-2}"
ECR_REPO_NAME="${ECR_REPO_NAME:-book-holder-api}"
SERVICE_NAME="${SERVICE_NAME:-book-holder-api}"
ECS_CPU="${ECS_CPU:-256}"
ECS_MEMORY="${ECS_MEMORY:-512}"
CONTAINER_PORT="${CONTAINER_PORT:-8000}"
HEALTH_CHECK_PATH="${HEALTH_CHECK_PATH:-/}"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-ecsTaskExecutionRole}"
INFRA_ROLE_NAME="${INFRA_ROLE_NAME:-ecsInfrastructureRoleForExpressServices}"
TASK_ROLE_NAME="${TASK_ROLE_NAME:-book-holder-api-task-role}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$REPO_ROOT/api"

# Pulls just the one named key out of .env — deliberately not `source .env`
# or a full export, which would also pull in AWS_ACCESS_KEY_ID/
# AWS_SECRET_ACCESS_KEY (the scoped Polly-only local-dev IAM user's keys,
# see create-dev-user.sh) into this script's shell and silently override the
# `aws login` session every other AWS call here relies on, breaking ECR/IAM/
# ECS access with an unrelated permissions error.
read_env_var() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^${key}=" "$file" | tail -1)"
  value="${line#*=}"
  # Strip one pair of surrounding double quotes, if present (plain bash
  # parameter expansion rather than sed, to sidestep nested-quote escaping).
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s' "$value"
}

# Precedence: shell-exported value wins, then infra/aws/.env.production (if
# present — gitignored, holds deploy-only values like the real ALLOWED_ORIGIN
# so it never has to be toggled in the root .env for local dev), then the
# root .env (the same COCKROACHDB_URL local dev uses — one cluster).
PROD_ENV_FILE="$REPO_ROOT/infra/aws/.env.production"
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

: "${COCKROACHDB_URL:?COCKROACHDB_URL is blank/missing in .env — set it before deploying, the container will crash-loop without it}"
: "${ALLOWED_ORIGIN:?ALLOWED_ORIGIN is blank/missing — set it in infra/aws/.env.production (preferred) or the root .env before deploying, or CORS will block it}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
IMAGE_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo latest)"
ECR_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME"
POLLY_CACHE_BUCKET_NAME="${POLLY_CACHE_BUCKET_NAME:-book-holder-polly-cache-$ACCOUNT_ID}"

echo "== Account $ACCOUNT_ID, region $AWS_REGION, image tag $IMAGE_TAG =="

# --- ECR repo (idempotent) ---
if ! aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$ECR_REPO_NAME" >/dev/null 2>&1; then
  echo "Creating ECR repo '$ECR_REPO_NAME'..."
  aws ecr create-repository --region "$AWS_REGION" --repository-name "$ECR_REPO_NAME" >/dev/null
else
  echo "ECR repo '$ECR_REPO_NAME' already exists — skipping."
fi

# --- Polly cache S3 bucket (idempotent) ---
if ! aws s3api head-bucket --bucket "$POLLY_CACHE_BUCKET_NAME" 2>/dev/null; then
  echo "Creating S3 bucket '$POLLY_CACHE_BUCKET_NAME' for Polly line-audio cache..."
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$POLLY_CACHE_BUCKET_NAME" --region "$AWS_REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$POLLY_CACHE_BUCKET_NAME" --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
  fi
else
  echo "S3 bucket '$POLLY_CACHE_BUCKET_NAME' already exists — skipping."
fi

# --- Build & push image ---
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Pinned to match the service's ARM64 runtimePlatform rather than inheriting
# the builder's architecture — deploying from an x86_64 machine would
# otherwise push an image ECS cannot exec, and the task would die on startup
# with "exec /tini: exec format error" while the service quietly rolled back.
docker build --platform linux/arm64 -t "$ECR_URI:$IMAGE_TAG" -t "$ECR_URI:latest" "$API_DIR"
docker push "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:latest"

# --- AWS-managed service-linked roles (idempotent) ---
# Distinct from the roles below: these are AWS's own predefined roles (fixed
# permissions, not ours to author) that ECS/ELB need to exist in the account
# at all before Express Mode can provision anything. Normally auto-created
# the first time the console/CLI touches the relevant service, but a fresh
# or lightly-used account (like this one, hit directly) may never have
# triggered that. create-service-linked-role has no "does it exist" flag, so
# check via get-role first — this is not something to try creating twice.
# service:role_name pairs — AWS's role-naming isn't a predictable transform
# of the service name (ECS is the all-caps acronym, ElasticLoadBalancing is
# title-cased), so this is an explicit list, not derived.
SERVICE_LINKED_ROLES="ecs.amazonaws.com:AWSServiceRoleForECS elasticloadbalancing.amazonaws.com:AWSServiceRoleForElasticLoadBalancing"
for pair in $SERVICE_LINKED_ROLES; do
  service="${pair%%:*}"
  role_name="${pair##*:}"
  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    echo "Creating AWS service-linked role '$role_name'..."
    aws iam create-service-linked-role --aws-service-name "$service" >/dev/null
  else
    echo "AWS service-linked role '$role_name' already exists — skipping."
  fi
done

# --- IAM roles (idempotent) ---
ROLE_JUST_CREATED=0

if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role '$EXEC_ROLE_NAME'..."
  aws iam create-role --role-name "$EXEC_ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }' >/dev/null
  aws iam attach-role-policy --role-name "$EXEC_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  ROLE_JUST_CREATED=1
else
  echo "IAM role '$EXEC_ROLE_NAME' already exists — skipping."
fi

if ! aws iam get-role --role-name "$INFRA_ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role '$INFRA_ROLE_NAME'..."
  aws iam create-role --role-name "$INFRA_ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Sid": "AllowAccessInfrastructureForECSExpressServices", "Effect": "Allow", "Principal": {"Service": "ecs.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }' >/dev/null
  aws iam attach-role-policy --role-name "$INFRA_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
  ROLE_JUST_CREATED=1
else
  echo "IAM role '$INFRA_ROLE_NAME' already exists — skipping."
fi

if ! aws iam get-role --role-name "$TASK_ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role '$TASK_ROLE_NAME'..."
  aws iam create-role --role-name "$TASK_ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }' >/dev/null
  ROLE_JUST_CREATED=1
else
  echo "IAM role '$TASK_ROLE_NAME' already exists — skipping creation (policy is reapplied below regardless)."
fi

# Inline policy, not a managed one — scoped to exactly what the running container
# needs at runtime. put-role-policy always overwrites, so this stays correct if
# the bucket name ever changes via POLLY_CACHE_BUCKET_NAME.
#
# The policy document itself lives in task-role-policy.sh, and the reasoning
# behind each statement lives there with it. It is a separate file because the
# deploy workflow verifies against the same document — this script is not the
# deploy path, so an action added here reaches production only when a human
# re-runs this script, and for the capture work nobody did. See that file's
# header for what that cost.
aws iam put-role-policy --role-name "$TASK_ROLE_NAME" --policy-name "PollyAndCacheBucketAccess" \
  --policy-document "$(AWS_REGION="$AWS_REGION" ACCOUNT_ID="$ACCOUNT_ID" \
    POLLY_CACHE_BUCKET_NAME="$POLLY_CACHE_BUCKET_NAME" "$(dirname "$0")/task-role-policy.sh")" >/dev/null

if [ "$ROLE_JUST_CREATED" = "1" ]; then
  echo "Roles just created — IAM is eventually consistent, waiting 15s before using them..."
  sleep 15
fi

EXEC_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$EXEC_ROLE_NAME"
INFRA_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$INFRA_ROLE_NAME"
TASK_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$TASK_ROLE_NAME"

# --- Express Mode service: create if missing, update if present ---
# Express Mode services land in the "default" cluster unless told otherwise
# (confirmed from AWS's own example service ARNs), so the ARN is
# predictable without needing a list call.
CANDIDATE_SERVICE_ARN="arn:aws:ecs:$AWS_REGION:$ACCOUNT_ID:service/default/$SERVICE_NAME"

# Built with jq rather than string interpolation for the same reason as the
# IAM policy above — safe to extend with values that might contain quotes
# (COCKROACHDB_URL has ':', '@', '?' in it) without re-deriving escaping
# rules. DENO_ENV is hardcoded "production", not sourced from .env — local
# dev's .env deliberately says LOCAL, but the deployed container should
# always be "production" regardless of what the deploying machine's local
# dev config says (it controls the auth cookie's Secure/SameSite=None
# flags, required since Amplify and ECS are different origins).
CONTAINER_ENV_JSON=$(jq -n \
  --arg port "$CONTAINER_PORT" \
  --arg region "$AWS_REGION" \
  --arg bucket "$POLLY_CACHE_BUCKET_NAME" \
  --arg defaultVoice "${POLLY_DEFAULT_VOICE_ID:-}" \
  --arg comparisonModel "${BEDROCK_MODEL_ID_COMPARISON:-}" \
  --arg appVersion "$IMAGE_TAG" \
  '[{name: "PORT", value: $port}, {name: "AWS_REGION", value: $region}, {name: "POLLY_CACHE_BUCKET", value: $bucket},
     {name: "DENO_ENV", value: "production"}, {name: "APP_VERSION", value: $appVersion}]
   + (if $defaultVoice != "" then [{name: "POLLY_DEFAULT_VOICE_ID", value: $defaultVoice}] else [] end)
   + (if $comparisonModel != "" then [{name: "BEDROCK_MODEL_ID_COMPARISON", value: $comparisonModel}] else [] end)')

# COCKROACHDB_URL/ALLOWED_ORIGIN come from Secrets Manager when the secret
# exists (see secrets-bootstrap.sh), and as plaintext env vars when it
# doesn't. Detected rather than assumed so this script works identically
# before and after that migration, and so re-running it never downgrades a
# secrets-based service back to plaintext — which is what would otherwise
# happen every time someone deployed from a machine that hadn't migrated.
SECRET_ID="${SECRET_ID:-book-holder/api}"
SECRET_ARN="$(aws secretsmanager describe-secret --region "$AWS_REGION" \
  --secret-id "$SECRET_ID" --query ARN --output text 2>/dev/null || true)"

if [ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ]; then
  echo "Secret '$SECRET_ID' found — wiring COCKROACHDB_URL/ALLOWED_ORIGIN from Secrets Manager."
  # ':KEY::' selects one key from the secret's JSON; the trailing empty
  # fields are the version-stage and version-id slots, blank for "current".
  CONTAINER_SECRETS_JSON=$(jq -n --arg arn "$SECRET_ARN" \
    '[{name: "COCKROACHDB_URL", valueFrom: ($arn + ":COCKROACHDB_URL::")},
      {name: "ALLOWED_ORIGIN",  valueFrom: ($arn + ":ALLOWED_ORIGIN::")}]')
else
  echo "Secret '$SECRET_ID' not found — passing COCKROACHDB_URL/ALLOWED_ORIGIN as plaintext env."
  echo "  (run ./infra/aws/secrets-bootstrap.sh to move them out of the task definition)"
  CONTAINER_ENV_JSON=$(jq -n \
    --argjson base "$CONTAINER_ENV_JSON" \
    --arg dbUrl "$COCKROACHDB_URL" \
    --arg allowedOrigin "$ALLOWED_ORIGIN" \
    '$base + [{name: "COCKROACHDB_URL", value: $dbUrl}, {name: "ALLOWED_ORIGIN", value: $allowedOrigin}]')
  CONTAINER_SECRETS_JSON='[]'
fi

PRIMARY_CONTAINER=$(jq -n \
  --arg image "$ECR_URI:$IMAGE_TAG" \
  --argjson port "$CONTAINER_PORT" \
  --argjson environment "$CONTAINER_ENV_JSON" \
  --argjson secrets "$CONTAINER_SECRETS_JSON" \
  '{image: $image, containerPort: $port, environment: $environment}
   + (if ($secrets | length) > 0 then {secrets: $secrets} else {} end)')

if aws ecs describe-express-gateway-service --region "$AWS_REGION" \
    --service-arn "$CANDIDATE_SERVICE_ARN" >/dev/null 2>&1; then
  echo "Updating existing Express Mode service '$SERVICE_NAME' ($CANDIDATE_SERVICE_ARN)..."
  aws ecs update-express-gateway-service --region "$AWS_REGION" \
    --service-arn "$CANDIDATE_SERVICE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --primary-container "$PRIMARY_CONTAINER" \
    --monitor-resources
else
  echo "Creating Express Mode service '$SERVICE_NAME'..."
  aws ecs create-express-gateway-service --region "$AWS_REGION" \
    --service-name "$SERVICE_NAME" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --primary-container "$PRIMARY_CONTAINER" \
    --cpu "$ECS_CPU" \
    --memory "$ECS_MEMORY" \
    --health-check-path "$HEALTH_CHECK_PATH" \
    --monitor-resources
fi

echo "Done — see the printed service block above for the application URL"
echo "(format: https://<service-name>.ecs.$AWS_REGION.on.aws/)."
