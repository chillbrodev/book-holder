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
# The thumbprint IS still validated, contrary to a lot of advice that says it
# isn't. It must be the SHA-1 of the *root* of the endpoint's certificate
# chain, and GitHub has since moved that endpoint from DigiCert to Let's
# Encrypt/ISRG — so the widely-copy-pasted 6938fd4d... DigiCert value now
# matches nothing in the chain, and STS rejects every token with a bare
# "Not authorized to perform sts:AssumeRoleWithWebIdentity".
#
# Derived from the live chain rather than hardcoded, so a future CA rotation
# is fixed by re-running this script instead of debugging an opaque STS error.
# The last certificate openssl prints is the root; the one before it is the
# signing intermediate, registered alongside it so a rotation to a new root
# under the same intermediate doesn't break the trust mid-flight.
echo "Reading the current certificate chain for $OIDC_HOST..."
CHAIN="$(echo | openssl s_client -servername "$OIDC_HOST" -showcerts \
  -connect "$OIDC_HOST:443" 2>/dev/null)"

thumbprint_at() {
  # $1: index from the end (0 = root, 1 = intermediate)
  printf '%s' "$CHAIN" \
    | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' \
    | awk -v want="$1" '
        /-----BEGIN CERTIFICATE-----/ {n++}
        {cert[n] = cert[n] $0 "\n"}
        END {print cert[n - want]}' \
    | openssl x509 -fingerprint -sha1 -noout 2>/dev/null \
    | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]'
}

ROOT_THUMBPRINT="$(thumbprint_at 0)"
INTERMEDIATE_THUMBPRINT="$(thumbprint_at 1)"

: "${ROOT_THUMBPRINT:?Could not read the certificate chain — check network access to $OIDC_HOST}"
echo "  root:         $ROOT_THUMBPRINT"
echo "  intermediate: $INTERMEDIATE_THUMBPRINT"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "Creating OIDC provider '$OIDC_HOST'..."
  aws iam create-open-id-connect-provider \
    --url "https://$OIDC_HOST" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$ROOT_THUMBPRINT" "$INTERMEDIATE_THUMBPRINT" >/dev/null
else
  # Refreshed rather than skipped: an existing provider carrying a stale
  # thumbprint is exactly the failure this script exists to prevent, and
  # re-running it should repair that.
  echo "OIDC provider '$OIDC_HOST' already exists — refreshing its thumbprints."
  aws iam update-open-id-connect-provider-thumbprint \
    --open-id-connect-provider-arn "$OIDC_ARN" \
    --thumbprint-list "$ROOT_THUMBPRINT" "$INTERMEDIATE_THUMBPRINT" >/dev/null
fi

# --- Deploy role (idempotent; trust policy reapplied either way) ---
# GitHub may issue *immutable* subject claims, which embed the numeric user
# and repo ids — "repo:owner@2694785/name@1307076327:ref:..." rather than
# "repo:owner/name:ref:...". That is deliberate on GitHub's part: renaming a
# repo or account then can't silently hand its trust to whoever claims the old
# name. A trust policy written against the plain form fails with a bare
# "Not authorized to perform sts:AssumeRoleWithWebIdentity" and no hint why.
#
# So ask GitHub for the actual prefix rather than assuming either shape. Needs
# the gh CLI authenticated; falls back to the plain form if it isn't available,
# which is correct for repos that haven't been migrated.
if command -v gh >/dev/null 2>&1 &&
   SUB_PREFIX="$(gh api "/repos/${GITHUB_REPO}/actions/oidc/customization/sub" \
     --jq .sub_claim_prefix 2>/dev/null)" && [ -n "$SUB_PREFIX" ]; then
  echo "GitHub reports subject prefix: $SUB_PREFIX"
else
  SUB_PREFIX="repo:${GITHUB_REPO}"
  echo "Could not query GitHub for the subject prefix — assuming '$SUB_PREFIX'."
  echo "  (install/authenticate the gh CLI if the role fails to assume)"
fi

# sub is pinned to one repo AND one ref. Without the ref condition, a PR
# branch from a fork could assume this role and deploy to production.
TRUST_POLICY="$(jq -n \
  --arg oidcArn "$OIDC_ARN" \
  --arg host "$OIDC_HOST" \
  --arg sub "${SUB_PREFIX}:ref:${GITHUB_REF}" \
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
    --arg ecrArn "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO_NAME}" \
    --arg svcArn "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:service/default/${SERVICE_NAME}" \
    --arg tdArn  "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/default-${SERVICE_NAME}:*" \
    --arg execArn "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}" \
    --arg taskArn "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}" \
    --arg secretArnPrefix "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${SECRET_ID}-*" \
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
        # Rolling the service registers a new task-definition revision, so
        # this is required even though the workflow never calls it directly.
        {Sid: "TaskDefinitions", Effect: "Allow", Resource: $tdArn,
         Action: ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
                  "ecs:DeregisterTaskDefinition", "ecs:TagResource"]},
        # IfExists over both ECS principals: the update is made by the ECS
        # control plane, so iam:PassedToService is not necessarily populated
        # with ecs-tasks. A plain StringEquals fails closed and denies the
        # PassRole. Scope still comes from Resource — an unscoped PassRole
        # would be a privilege-escalation path to any role in the account.
        {Sid: "PassRolesToEcs", Effect: "Allow", Action: "iam:PassRole",
         Resource: [$execArn, $taskArn],
         Condition: {StringEqualsIfExists: {"iam:PassedToService": ["ecs-tasks.amazonaws.com", "ecs.amazonaws.com"]}}},
        {Sid: "ResolveSecretArnOnly", Effect: "Allow",
         Action: "secretsmanager:DescribeSecret", Resource: $secretArnPrefix},
        # Read-only, and the whole point is that it stays that way. The workflow
        # verifies that the task role grants what the shipped code needs, rather
        # than applying the policy itself — applying would mean iam:PutRolePolicy
        # in CI, which is the privilege this role exists to avoid.
        #
        # Without this the verification step fails closed on its first run and
        # blocks every deploy, so it is not optional once that step exists.
        # SimulatePrincipalPolicy takes "*": the resource of a simulate call is
        # the principal being simulated, and scoping it to the task role ARN is
        # not expressible here.
        {Sid: "VerifyTaskRoleOnly", Effect: "Allow", Resource: "*",
         Action: ["iam:SimulatePrincipalPolicy", "iam:GetContextKeysForPrincipalPolicy"]}
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
