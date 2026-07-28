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
# NOTE: this only wires up the container env vars the Polly workflow needs
# (AWS_REGION, POLLY_CACHE_BUCKET, and POLLY_DEFAULT_VOICE_ID if exported
# before running — per-character voices live in characters.polly_voice_id,
# not an env var). COCKROACHDB_URL, ALLOWED_ORIGIN, and the rest of
# .env.example are NOT yet passed to the deployed container — that's a
# pre-existing gap, not something this script closes.
#
# Usage:
#   ./infra/aws/ecs-deploy.sh
#
# Optional overrides:
#   AWS_REGION=us-west-2                              (default)
#   ECR_REPO_NAME=book-holder-api                      (default)
#   SERVICE_NAME=book-holder-api                        (default)
#   ECS_CPU=0.25                                        (default — vCPU; confirm the API accepts fractional
#                                                         values, docs examples only show whole numbers)
#   ECS_MEMORY=0.5                                      (default — GB)
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
ECS_CPU="${ECS_CPU:-0.25}"
ECS_MEMORY="${ECS_MEMORY:-0.5}"
CONTAINER_PORT="${CONTAINER_PORT:-8000}"
HEALTH_CHECK_PATH="${HEALTH_CHECK_PATH:-/}"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-ecsTaskExecutionRole}"
INFRA_ROLE_NAME="${INFRA_ROLE_NAME:-ecsInfrastructureRoleForExpressServices}"
TASK_ROLE_NAME="${TASK_ROLE_NAME:-book-holder-api-task-role}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$REPO_ROOT/api"

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

docker build -t "$ECR_URI:$IMAGE_TAG" -t "$ECR_URI:latest" "$API_DIR"
docker push "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:latest"

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

# Inline policy, not a managed one — scoped to exactly what the running
# container needs at runtime (Polly synthesis + read/write/head on its own
# cache bucket). put-role-policy always overwrites, so this stays correct if
# the bucket name ever changes via POLLY_CACHE_BUCKET_NAME.
#
# Bucket-level s3:ListBucket is included alongside the object-level actions
# on purpose, not for browsing the bucket — without it, S3 masks "object
# doesn't exist" as a generic 403 instead of 404 for this principal (an
# information-hiding default), which breaks the cache-miss detection
# PollyService.getLineAudio/warmLine rely on (see clients/s3-client's
# isNotFound()). Confirmed by hitting exactly this while testing.
aws iam put-role-policy --role-name "$TASK_ROLE_NAME" --policy-name "PollyAndCacheBucketAccess" \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "PollySynthesize", "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*"},
    {"Sid": "PollyCacheBucketObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"], "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME/*"},
    {"Sid": "PollyCacheBucketList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME"}
  ]
}
EOF
)" >/dev/null

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
# later without re-deriving escaping rules.
CONTAINER_ENV_JSON=$(jq -n \
  --arg port "$CONTAINER_PORT" \
  --arg region "$AWS_REGION" \
  --arg bucket "$POLLY_CACHE_BUCKET_NAME" \
  --arg defaultVoice "${POLLY_DEFAULT_VOICE_ID:-}" \
  '[{name: "PORT", value: $port}, {name: "AWS_REGION", value: $region}, {name: "POLLY_CACHE_BUCKET", value: $bucket}]
   + (if $defaultVoice != "" then [{name: "POLLY_DEFAULT_VOICE_ID", value: $defaultVoice}] else [] end)')

PRIMARY_CONTAINER=$(jq -n \
  --arg image "$ECR_URI:$IMAGE_TAG" \
  --argjson port "$CONTAINER_PORT" \
  --argjson environment "$CONTAINER_ENV_JSON" \
  '{image: $image, containerPort: $port, environment: $environment}')

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
