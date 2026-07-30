#!/usr/bin/env bash
# Creates the GitHub OIDC identity provider and the scoped role that
# .github/workflows/deploy-api.yml assumes — so CI deploys with no long-lived
# AWS keys stored in GitHub. Run once, locally, by a human with IAM rights;
# idempotent, same pattern as ecs-deploy.sh and budget-alert.sh.
#
# The role is deliberately much narrower than ecs-deploy.sh's own permissions:
# it can push images and roll the existing service, and nothing else. It
# cannot create roles, cannot change policies, and cannot read the database
# secret — the ECS execution role resolves that at container start, not CI.
#
# Requires: aws CLI configured (see infra/aws/README.md — `aws login`).
#
# Usage:
#   ./infra/aws/github-oidc-bootstrap.sh
#
# Optional overrides:
#   GITHUB_REPO=chillbrodev/book-holder   (default)
#   GITHUB_REF=refs/heads/main            (default — only this branch may deploy)
#   AWS_REGION=us-west-2                  (default)
#   ROLE_NAME=book-holder-api-deploy      (default)
#   ECR_REPO_NAME=book-holder-api         (default)
#   SERVICE_NAME=book-holder-api          (default)
#   SECRET_ID=book-holder/api             (default)

set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-chillbrodev/book-holder}"
GITHUB_REF="${GITHUB_REF:-refs/heads/main}"
AWS_REGION="${AWS_REGION:-us-west-2}"
ROLE_NAME="${ROLE_NAME:-book-holder-api-deploy}"
ECR_REPO_NAME="${ECR_REPO_NAME:-book-holder-api}"
SERVICE_NAME="${SERVICE_NAME:-book-holder-api}"
SECRET_ID="${SECRET_ID:-book-holder/api}"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-ecsTaskExecutionRole}"
TASK_ROLE_NAME="${TASK_ROLE_NAME:-book-holder-api-task-role}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
OIDC_HOST="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::$ACCOUNT_ID:oidc-provider/$OIDC_HOST"

echo "== Account $ACCOUNT_ID, repo $GITHUB_REPO, ref $GITHUB_REF =="

# --- OIDC provider (idempotent) ---
# The thumbprint is still a required argument, but AWS stopped validating it
# for this provider — it verifies GitHub's certificate chain natively. The
# value below is the long-published GitHub one, kept so the call succeeds.
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "Creating OIDC provider '$OIDC_HOST'..."
  aws iam create-open-id-connect-provider \
    --url "https://$OIDC_HOST" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" >/dev/null
else
  echo "OIDC provider '$OIDC_HOST' already exists — skipping."
fi

# --- Deploy role (idempotent; trust policy reapplied either way) ---
# sub is pinned to one repo AND one ref. Without the ref condition, a PR
# branch from a fork could assume this role and deploy to production.
TRUST_POLICY="$(jq -n \
  --arg oidcArn "$OIDC_ARN" \
  --arg host "$OIDC_HOST" \
  --arg sub "repo:${GITHUB_REPO}:ref:${GITHUB_REF}" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {Federated: $oidcArn},
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          ($host + ":aud"): "sts.amazonaws.com",
          ($host + ":sub"): $sub
        }
      }
    }]
  }')"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role '$ROLE_NAME'..."
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" >/dev/null
else
  echo "IAM role '$ROLE_NAME' already exists — updating its trust policy."
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
fi

# --- Permissions (always overwritten, so this file stays the source of truth) ---
# GetAuthorizationToken is account-wide by API design (it takes no resource);
# every other ECR action is pinned to this one repository. PassRole is
# required because updating the service hands ECS the execution/task roles —
# and is scoped to exactly those two ARNs, since an unscoped iam:PassRole is
# an privilege-escalation path to any role in the account.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "DeployApi" \
  --policy-document "$(jq -n \
    --arg ecrArn "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/$ECR_REPO_NAME" \
    --arg svcArn "arn:aws:ecs:$AWS_REGION:$ACCOUNT_ID:service/default/$SERVICE_NAME" \
    --arg execArn "arn:aws:iam::$ACCOUNT_ID:role/$EXEC_ROLE_NAME" \
    --arg taskArn "arn:aws:iam::$ACCOUNT_ID:role/$TASK_ROLE_NAME" \
    --arg secretArnPrefix "arn:aws:secretsmanager:$AWS_REGION:$ACCOUNT_ID:secret:$SECRET_ID-*" \
    '{
      Version: "2012-10-17",
      Statement: [
        {Sid: "EcrAuth",    Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*"},
        {Sid: "EcrPush",    Effect: "Allow", Resource: $ecrArn,
         Action: ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
                  "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
                  "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeRepositories"]},
        {Sid: "RollService", Effect: "Allow", Resource: $svcArn,
         Action: ["ecs:DescribeExpressGatewayService", "ecs:UpdateExpressGatewayService"]},
        {Sid: "PassRolesToEcs", Effect: "Allow", Action: "iam:PassRole",
         Resource: [$execArn, $taskArn],
         Condition: {StringEquals: {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}},
        {Sid: "ResolveSecretArnOnly", Effect: "Allow",
         Action: "secretsmanager:DescribeSecret", Resource: $secretArnPrefix}
      ]
    }')" >/dev/null

echo
echo "Done. Add this as a GitHub repository secret named AWS_ACCOUNT_ID:"
echo
echo "    $ACCOUNT_ID"
echo
echo "  gh secret set AWS_ACCOUNT_ID --body '$ACCOUNT_ID'"
echo
echo "Note it is not really a secret — it is a repo secret only to keep the"
echo "account id out of the workflow file and its logs."
