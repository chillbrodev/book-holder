#!/usr/bin/env bash
# Creates (idempotently) a scoped IAM user for local dev — currently Polly
# synthesis, Transcribe streaming, and read/write/head on the Polly cache
# bucket, nothing else.
# Deliberately separate from the ECS task role in ecs-deploy.sh: that's what
# the *deployed* container uses (no static keys, task-role credentials
# resolved automatically) — this is only for a developer's local .env, where
# the AWS SDK needs *some* static credential source (see
# clients/config-client/configClient.ts's ConfigClient.Aws comment).
#
# As local dev needs more AWS access later (Bedrock, S3 recordings), extend the
# inline policy below rather than creating another user — one scoped dev
# identity, its permissions grown deliberately.
#
# Requires: aws CLI configured (aws login), jq, authorized to manage IAM.
#
# Usage:
#   ./infra/aws/create-dev-user.sh
#
# Optional overrides:
#   AWS_REGION=us-west-2                                          (default)
#   USER_NAME=book-holder-local-dev                                (default)
#   POLLY_CACHE_BUCKET_NAME=book-holder-polly-cache-<account-id>   (default, same as ecs-deploy.sh)

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-west-2}"
USER_NAME="${USER_NAME:-book-holder-local-dev}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
POLLY_CACHE_BUCKET_NAME="${POLLY_CACHE_BUCKET_NAME:-book-holder-polly-cache-$ACCOUNT_ID}"

echo "== Account $ACCOUNT_ID, user '$USER_NAME', cache bucket '$POLLY_CACHE_BUCKET_NAME' =="

# --- IAM user (idempotent) ---
if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "Creating IAM user '$USER_NAME'..."
  aws iam create-user --user-name "$USER_NAME" >/dev/null
else
  echo "IAM user '$USER_NAME' already exists — skipping creation."
fi

# --- Scoped inline policy (idempotent — put-user-policy always overwrites) ---
# s3:DeleteObject is here but deliberately NOT in ecs-deploy.sh's task role —
# the running app never deletes cache objects (see clients/s3-client.ts),
# only local admin/migration scripts do.
#
# transcribe:StartStreamTranscription takes "*" because Transcribe streaming has
# no resource to scope to — a stream isn't a named, persisted resource the way a
# batch transcription job is, so IAM offers no ARN to narrow it with. Same
# reasoning as polly:SynthesizeSpeech.
#
# Bedrock needs TWO resource ARNs for one call, which is the least obvious grant
# in this file. Nova Micro is not available in-region in us-west-2 — AWS's model
# card lists us-west-2 as In-Region ✗ / Geo ✓ — so it can only be reached from
# here through the US geo inference profile, `us.amazon.nova-micro-v1:0` (see
# api/src/clients/config-client/configClient.ts). Invoking a profile is
# authorized against the profile ARN *and* against the foundation-model ARN in
# every region the profile may route to; granting only the profile fails with an
# AccessDenied naming a foundation-model ARN in a region you never configured,
# which reads like a bug rather than a missing grant. us-east-1/us-east-2/
# us-west-2 are the US geo's destination regions per the same model card.
#
# Titan Text Embeddings V2, in the same file, is the OPPOSITE case and is worth
# reading beside Nova rather than pattern-matched onto it. Titan V2 IS available
# in-region, has no inference profile, and so takes exactly one ARN — the bare
# foundation model in this region. Adding profile ARNs for it would grant
# nothing that exists.
#
# Both grants are duplicated in task-role-policy.sh for the deployed task role.
# Changing an embedding or comparison model means editing both files; the model
# id in configClient.ts is not where authorization lives.
aws iam put-user-policy --user-name "$USER_NAME" --policy-name "LocalDevAccess" \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "PollySynthesize", "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*"},
    {"Sid": "TranscribeStreaming", "Effect": "Allow", "Action": "transcribe:StartStreamTranscription", "Resource": "*"},
    {"Sid": "BedrockInvokeNova", "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": [
      "arn:aws:bedrock:$AWS_REGION:$ACCOUNT_ID:inference-profile/us.amazon.nova-micro-v1:0",
      "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0",
      "arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-micro-v1:0",
      "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-micro-v1:0"
    ]},
    {"Sid": "BedrockInvokeTitanEmbeddings", "Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": [
      "arn:aws:bedrock:$AWS_REGION::foundation-model/amazon.titan-embed-text-v2:0"
    ]},
    {"Sid": "PollyCacheBucketObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME/*"},
    {"Sid": "PollyCacheBucketList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME"}
  ]
}
EOF
)" >/dev/null
echo "Inline policy 'LocalDevAccess' applied — Polly synthesis, Transcribe streaming, cache bucket read/write/head/delete/list only."

# --- Access key: only create if the user has none yet (AWS shows the secret
# exactly once, at creation — can't be recovered from an existing key later,
# and IAM caps a user at 2 keys, so this stays safe to re-run). ---
EXISTING_KEYS="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
if [ -n "$EXISTING_KEYS" ]; then
  echo "User already has an access key ($EXISTING_KEYS) — not creating another."
  echo "For fresh keys, delete the old one first: aws iam delete-access-key --user-name $USER_NAME --access-key-id $EXISTING_KEYS"
  exit 0
fi

echo "Creating access key..."
KEY_JSON="$(aws iam create-access-key --user-name "$USER_NAME")"
ACCESS_KEY_ID="$(echo "$KEY_JSON" | jq -r '.AccessKey.AccessKeyId')"
SECRET_ACCESS_KEY="$(echo "$KEY_JSON" | jq -r '.AccessKey.SecretAccessKey')"

# Written straight into .env, never printed to the terminal — this is the
# only moment AWS will ever reveal the secret half of this key pair.
if grep -q "^AWS_ACCESS_KEY_ID=" "$ENV_FILE"; then
  sed -i '' "s|^AWS_ACCESS_KEY_ID=.*|AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID|" "$ENV_FILE"
else
  echo "AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID" >> "$ENV_FILE"
fi
if grep -q "^AWS_SECRET_ACCESS_KEY=" "$ENV_FILE"; then
  sed -i '' "s|^AWS_SECRET_ACCESS_KEY=.*|AWS_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY|" "$ENV_FILE"
else
  echo "AWS_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY" >> "$ENV_FILE"
fi
# A permanent IAM user key needs no session token — drop one if a previous
# temporary-credential attempt left it behind.
sed -i '' '/^AWS_SESSION_TOKEN=/d' "$ENV_FILE"

echo "Done — AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY written to $ENV_FILE (secrets not printed here)."
