#!/usr/bin/env bash
# Prints the ECS task role's inline policy as JSON. Prints only — grants nothing.
#
# This exists as its own file because **two** things need to agree about what the
# running container is allowed to do, and for a long time only one of them knew:
#
#   * `ecs-deploy.sh` applies this policy. It is local, human-run, and occasional.
#   * `.github/workflows/deploy-api.yml` ships the code. It runs on every push and
#     deliberately holds no IAM write permission.
#
# Nothing connected the two, so a commit that added an action here reached
# production only if someone remembered to re-run the bootstrap script. On
# 2026-08-08 the capture work shipped exactly that way: the deploy went green,
# and every rehearsal died with `AccessDeniedException:
# transcribe:StartStreamTranscription` because the task role was still the
# pre-capture version. The mic reported "Can't hear you — check your mic", which
# points at the actor's hardware rather than at an IAM policy, so it cost a real
# debugging session to find.
#
# The workflow now *verifies* against this file rather than applying it — read-only
# IAM in CI, so the no-writes-in-CI posture holds — and fails the deploy naming the
# missing action. A policy printed once and consumed by both is what makes that
# check meaningful; a second copy in the workflow would drift the same way.
#
# Usage:
#   AWS_REGION=us-west-2 ACCOUNT_ID=… POLLY_CACHE_BUCKET_NAME=… ./task-role-policy.sh
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${ACCOUNT_ID:?ACCOUNT_ID is required}"
: "${POLLY_CACHE_BUCKET_NAME:?POLLY_CACHE_BUCKET_NAME is required}"

# polly:SynthesizeSpeech and transcribe:StartStreamTranscription take "*" because
# neither has a resource to scope to — a Transcribe *stream* is not a named,
# persisted resource the way a batch transcription job is, so IAM offers no ARN to
# narrow it with.
#
# Bedrock, by contrast, is scoped tightly — and needs two ARN shapes for one call.
# Nova Micro has no in-region presence in us-west-2 (model card: In-Region ✗ /
# Geo ✓), so it is reached through the US geo inference profile
# `us.amazon.nova-micro-v1:0`. A profile invocation is authorized against the
# profile ARN *and* the foundation-model ARN in each region the profile can route
# to; granting one without the other yields an AccessDenied naming a region that
# appears nowhere in this deployment. Keep these in step with
# api/src/clients/config-client/configClient.ts's comparisonModelId.
#
# Titan Text Embeddings V2 is the opposite shape and deliberately gets its own
# statement rather than another ARN in the Nova one. It IS available in-region,
# has no inference profile, and needs exactly one ARN: the bare foundation model
# here. Keep it in step with configClient.ts's embeddingModelId — and with
# create-dev-user.sh, which carries the same pair for the local user. Adding a
# model is two files, never one.
#
# Bucket-level s3:ListBucket sits alongside the object-level actions on purpose,
# not for browsing: without it S3 masks "object doesn't exist" as a generic 403
# instead of 404 for this principal, which breaks the cache-miss detection
# PollyService relies on (see clients/s3-client's isNotFound()). Confirmed by
# hitting exactly this while testing.
#
# Note s3:DeleteObject is deliberately absent, unlike create-dev-user.sh — the
# running app never deletes cache objects, only local admin scripts do.
cat <<EOF
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
    {"Sid": "PollyCacheBucketObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"], "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME/*"},
    {"Sid": "PollyCacheBucketList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::$POLLY_CACHE_BUCKET_NAME"}
  ]
}
EOF
