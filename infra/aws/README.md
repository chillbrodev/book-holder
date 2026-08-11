# AWS — credentials, budget alert, deploy config

## Credentials (local dev)

Two separate credential paths — don't conflate them:

**The `aws` CLI itself** (running `ecs-deploy.sh`, `budget-alert.sh`, `create-dev-user.sh`, or any manual
`aws ...` command) uses `aws login` (AWS CLI ≥2.32.0): reuses your AWS Console sign-in through a browser
OAuth flow, caches short-lived credentials (auto-refreshed, ~12h) locally. No long-lived secret sitting in
`~/.aws/credentials` to leak or rotate.

```
aws login
```

Currently authorized against the account root session — simplest path for a solo personal AWS account.
Root is unrestricted, so treat this like any other elevated session (don't leave it running unnecessarily,
re-run `aws login` when it expires rather than reaching for a permanent key). If tighter scoping is ever
wanted, an IAM user with the `SignInLocalDevelopmentAccess` managed policy can be used with `aws login`
instead — see the discussion this traded off against in conversation history if picking that up later.

**The `api` app's own AWS SDK calls** (Polly, S3 — made by whatever process runs `deno task dev`/`warm-polly-cache`/`test-polly-line`
on your machine) **cannot use `aws login` sessions at all.** `aws login` creates a CLI-only `login_session`
profile type in `~/.aws/config` that the AWS SDK for JavaScript doesn't recognize — confirmed by hitting this
directly: the SDK's default credential chain fails with "Could not load credentials from any providers" against
a fresh `aws login` session, even though the CLI itself authenticates fine. (A `credential_process` shim can
bridge this, but it means granting the Deno process subprocess/`~/.aws` read permissions for something that
still expires every ~12h — more moving parts than it's worth here.)

Instead, run:

```
./infra/aws/create-dev-user.sh
```

Creates a scoped IAM user (`book-holder-local-dev`) with a permanent access key, writes
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` straight into the root `.env` (never printed to the terminal —
that's the only moment AWS reveals the secret half of the pair), and grants exactly `polly:SynthesizeSpeech`
plus read/write/head/list on the Polly cache bucket — nothing broader. Idempotent: re-running updates the
policy in place and skips creating a second access key if one already exists (IAM caps a user at 2 keys,
and AWS won't show you an existing secret again). As local dev needs more AWS access later (Bedrock,
Transcribe), extend this script's policy rather than creating another user.

Bucket-level `s3:ListBucket` is included deliberately, not just object-level `GetObject`/`PutObject`/`HeadObject`
— without it, S3 masks "object doesn't exist" as a generic `403` instead of `404` for this principal, which
breaks the cache-miss detection `PollyService` relies on. Also hit this directly; see the matching comment in
`ecs-deploy.sh`'s task role policy.

## Budget alert

```
BUDGET_ALERT_EMAIL=you@example.com ./infra/aws/budget-alert.sh
```

Creates (or confirms) an AWS Budget: $25/month by default (override with `BUDGET_AMOUNT_USD`), email alerts
at 80% and 100% of actual monthly spend. Idempotent — re-running with the same `BUDGET_NAME` (default
`book-holder-monthly`) skips creation if it already exists rather than erroring.

The alert email isn't hardcoded into the script on purpose — avoids putting a personal email address into
git history for something that isn't actually a secret but also doesn't need to be permanent/committed.

## Deploy config (ECS Express Mode + Amplify)

Not built yet. Per `docs/ORCHESTRATION_PLAN.md` Week 1, this is still outstanding — `frontend` and `api` are
scaffolded (see their own READMEs/`deno.json`) but neither is deployed yet.

`api` is Deno + Hono, deployed as a Docker image via AWS **ECS Express Mode** — the AWS-recommended
replacement for App Runner (App Runner stopped accepting new customers 2026-04-30 and is now in maintenance
mode). Express Mode needs only a container image + task execution role + infra role, and auto-provisions the
Fargate service, ALB w/ SSL, autoscaling, and networking (default VPC, public subnets, no NAT Gateway —
confirmed, not a cost concern) — same billed resources as a hand-rolled ECS service, just far less setup.
Realistic always-on hosting cost is ~$30/mo (the ALB is the dominant line item, not the Fargate task itself)
— see `docs/PROJECT_PLAN.md` §9 for the full breakdown. The $25/mo budget default above is below that; bump
it with `BUDGET_AMOUNT_USD=40 ./infra/aws/budget-alert.sh` once ECS is live.

```
./infra/aws/ecs-deploy.sh
```

Builds `api/Dockerfile`, pushes to ECR, and creates (first run) or updates (subsequent runs) the
`book-holder-api` Express Mode service — idempotent, same pattern as `budget-alert.sh`. Requires Docker, `jq`,
and an authenticated AWS CLI session locally. **This creates real, billed AWS resources (ALB + Fargate task)
the moment the service goes `ACTIVE`** — not a dry run, don't run it casually against a real account.

Also provisions, idempotently, what the Polly workflow needs at runtime:
- An S3 bucket for cached line audio (`book-holder-polly-cache-<account-id>` by default — S3 bucket names
  are globally unique, so the account ID is appended; override with `POLLY_CACHE_BUCKET_NAME`).
- A **task role** (`book-holder-api-task-role` by default, override with `TASK_ROLE_NAME`) — distinct from
  the task *execution* role above, which only covers image pull + logs. This is the role the running
  container assumes to call `polly:SynthesizeSpeech` and `s3:GetObject`/`PutObject`/`HeadObject` on its own
  cache bucket, scoped via an inline policy rather than a broad managed one.
- Passes `AWS_REGION` and `POLLY_CACHE_BUCKET` into the container's environment automatically, plus
  `POLLY_DEFAULT_VOICE_ID` if it's exported in your shell before running the script. Per-character voices
  live in `characters.polly_voice_id` (DB, not env) — see `docs/BE_PLAN.md` §4.
- Also passes `DENO_ENV=production` (hardcoded — required for the auth cookie's cross-origin
  `Secure`/`SameSite=None` flags, since Amplify and ECS are different origins), plus `COCKROACHDB_URL` and
  `ALLOWED_ORIGIN`, pulled from the root `.env` (or exported to override — e.g.
  `ALLOWED_ORIGIN=https://your-domain ./infra/aws/ecs-deploy.sh`). The script parses just those two specific
  keys out of `.env` rather than sourcing the whole file — sourcing it would also export
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (the scoped Polly-only local-dev user's keys, see
  `create-dev-user.sh` above) into the script's own shell, silently overriding the `aws login` session every
  other AWS call in this script relies on. Fails fast with a clear message if either is blank/missing —
  `ALLOWED_ORIGIN` in particular needs to be the *deployed frontend's* real origin, not `localhost`, or CORS
  blocks it. Set it in `infra/aws/.env.production` (gitignored — not a secret, just kept out of git since
  it's deploy-only config) rather than the root `.env`, which should stay blank so local dev keeps falling
  back to `http://localhost:5173` (see `configClient.ts`). Precedence is shell-exported value >
  `infra/aws/.env.production` > root `.env`, so a one-off `ALLOWED_ORIGIN=... ./infra/aws/ecs-deploy.sh`
  still works too — but `.env.production` means you never have to toggle anything for local dev again.

`BEDROCK_MODEL_ID_COMPARISON` is passed **only when set**, because `configClient.ts` already carries a
working default (`us.amazon.nova-micro-v1:0` — the US geo inference profile, whose `us.` prefix is required
because Nova Micro has no in-region presence in us-west-2). The variable exists so the model can be changed
without shipping a commit: export it before `ecs-deploy.sh`, or — for the real deploy path — set the
`BEDROCK_MODEL_ID_COMPARISON` **repository variable** under Settings → Variables, which
`.github/workflows/deploy-api.yml` reads.

If you point it at a different model, update the `BedrockInvokeNova` statement in both `ecs-deploy.sh` and
`create-dev-user.sh` to match. A profile invocation is authorized against the inference-profile ARN *and*
the foundation-model ARN in every region the profile can route to, so a model swap is two ARN shapes in two
files, not one string in one.

**Still not wired into the container**: `BEDROCK_MODEL_ID_SUMMARY`/`S3_RECORDINGS_BUCKET` — nothing reads
them yet (the coaching-note and S3-recordings work isn't built), so there's nothing to pass until that
exists.

For **local dev**, set `POLLY_CACHE_BUCKET` in the root `.env` to whatever bucket name you're using (run
`ecs-deploy.sh` once to have it create `book-holder-polly-cache-<account-id>` and reuse that name locally, or
create your own bucket manually first). Local Polly calls use the same code path as deployed — no mock — with
credentials resolved from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env` rather than a task role.

---

## Automatic API deploys (`.github/workflows/deploy-api.yml`)

Amplify redeploys the frontend on every push to `main`; the API does not, so a push touching both ships a
frontend against a stale API. `deploy-api.yml` closes that gap: on any push to `main` under `api/**` it
builds the image, pushes it to ECR, rolls the Express Mode service, and polls `/health` until the new task
serves 200 (a green deploy that 5xxs is still a failed deploy).

The workflow deliberately does **not** run `ecs-deploy.sh`. That script *bootstraps* — it creates IAM roles,
attaches policies, creates the S3 cache bucket and the service itself — and CI holding `iam:CreateRole` /
`iam:PutRolePolicy` is far more privilege than a deploy needs. Bootstrap stays local and occasional; CI only
builds, pushes, and updates.

### One-time setup

```bash
./infra/aws/secrets-bootstrap.sh      # COCKROACHDB_URL + ALLOWED_ORIGIN -> Secrets Manager
./infra/aws/github-oidc-bootstrap.sh  # OIDC provider + scoped book-holder-api-deploy role
gh secret set AWS_ACCOUNT_ID --body "$(aws sts get-caller-identity --query Account --output text)"
./infra/aws/ecs-deploy.sh             # once more, so the service picks up the secrets-based task def
```

Order matters only in that `secrets-bootstrap.sh` should run before the final `ecs-deploy.sh`.

### Credentials

CI authenticates via GitHub's OIDC provider assuming `book-holder-api-deploy` — there are **no long-lived AWS
keys in the repo**. The role's trust policy pins both the repository *and* `refs/heads/main`; without the ref
condition a branch from a fork could assume it and deploy to production.

The role can push to this one ECR repository, describe/update this one service, and `PassRole` exactly the
execution and task roles (scoped — an unscoped `iam:PassRole` is a privilege-escalation path to any role in
the account). It **cannot** create roles, change policies, or read the database secret. Its only IAM
capability is read-only: `iam:SimulatePrincipalPolicy`, for the check below.

### The task role is verified on every deploy, not applied

The task role's policy lives in **`infra/aws/task-role-policy.sh`**, which prints it and grants nothing.
Two things consume it: `ecs-deploy.sh` applies it, and `.github/workflows/deploy-api.yml` *verifies* it.

That split exists because of a real outage. `ecs-deploy.sh` is not the deploy path — it is local and
human-run — so an IAM action added alongside code reached production only if someone remembered to re-run
it. On **August 8 2026** the capture work merged with `transcribe:StartStreamTranscription` added to this
script, nobody re-ran it, and every rehearsal in production failed with
`AccessDeniedException: transcribe:StartStreamTranscription` — **behind a completely green deploy**. The mic
reported "Can't hear you — check your mic", which points at the actor's hardware rather than at IAM.

The workflow now simulates every action in that policy against the live task role before building, and fails
the deploy naming the missing action. It verifies rather than applies deliberately: applying would mean
`iam:PutRolePolicy` in CI, which is exactly the privilege this role is designed not to have.

**When you add an action**, put it in `task-role-policy.sh` and re-run `ecs-deploy.sh`. If you forget, the
next deploy goes red with the action name in the error instead of green with a runtime 403.

### Secrets

`COCKROACHDB_URL` and `ALLOWED_ORIGIN` live in one Secrets Manager secret, `book-holder/api`, as JSON. The
task definition references them by ARN with a `:KEY::` selector, so CI passes only the ARN and never handles
the values; the ECS **execution** role resolves them at container start. (Execution role, not task role — the
task role only covers what the running app calls itself, i.e. Polly and S3.)

This also gets the database URL out of the task definition, where it was previously plaintext and readable by
anyone who could describe the service in the console.

`ecs-deploy.sh` detects whether the secret exists and uses it if so, falling back to plaintext env if not — so
it behaves identically before and after this migration, and re-running it from an un-migrated machine can't
silently downgrade a secrets-based service back to plaintext.

To rotate: re-run `secrets-bootstrap.sh` after updating `.env.production`, then redeploy.

### Two OIDC gotchas this hit, both worth knowing

**Immutable subject claims.** GitHub may issue subjects that embed the numeric
user and repo ids — `repo:owner@2694785/name@1307076327:ref:refs/heads/main`,
not `repo:owner/name:ref:refs/heads/main`. That's deliberate: renaming a repo
or account then can't hand its trust to whoever claims the old name. A trust
policy written against the plain form fails with a bare *"Not authorized to
perform sts:AssumeRoleWithWebIdentity"* and no indication why. The bootstrap
script asks GitHub for the real prefix
(`/repos/{repo}/actions/oidc/customization/sub`) rather than assuming either
shape, so it needs the `gh` CLI authenticated.

**The thumbprint is still validated.** Plenty of advice says AWS ignores it
now; it does not. It must be the SHA-1 of the *root* of the endpoint's
certificate chain, and GitHub has moved that endpoint from DigiCert to Let's
Encrypt/ISRG — so the widely-copy-pasted `6938fd4d…` DigiCert value now matches
nothing and produces the same opaque error. The script derives it from the live
chain instead of hardcoding it, and refreshes it on re-run, so a future CA
rotation is fixed by running the script again.

Both failures look identical from the workflow log, so check the trust policy's
`sub` first and the thumbprint second.

### Permissions the deploy role needs, and why

`ecs:RegisterTaskDefinition` is required even though the workflow never calls
it — rolling an Express Mode service registers a new task-definition revision
under the hood.

`iam:PassRole` uses `StringEqualsIfExists` over both `ecs-tasks.amazonaws.com`
and `ecs.amazonaws.com`: the update is made by the ECS control plane, so
`iam:PassedToService` isn't necessarily populated with `ecs-tasks`, and a plain
`StringEquals` fails closed. The scoping that matters is `Resource` — an
unscoped `iam:PassRole` is a privilege-escalation path to any role in the
account.

### The image must be arm64

The service's `runtimePlatform` is `ARM64` — it was created from an image built
on an Apple Silicon Mac, and arm64 is the cheaper Fargate option anyway. Both
`ecs-deploy.sh` and the workflow pass `--platform linux/arm64` explicitly
rather than inheriting the builder's architecture, and the workflow runs on
`ubuntu-24.04-arm` so it builds natively instead of under QEMU.

Get this wrong and the failure is quiet: the task dies at startup with
`exec /tini: exec format error`, ECS rolls the service back to the previous
revision, and the endpoint keeps happily serving the old build. That is
exactly why the deploy step waits for `/health` to report the **deploying
commit** rather than merely returning 200 — the old revision returns 200 the
whole time, so a status-only check passes instantly and proves nothing.

`APP_VERSION` carries that commit into the container; `/health` echoes it back
as `version`, and reports `"dev"` locally where nothing sets it.
