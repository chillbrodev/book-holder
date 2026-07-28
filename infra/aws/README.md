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

**Still not wired into the container**: `BEDROCK_MODEL_ID_*`/`S3_RECORDINGS_BUCKET` — nothing reads them yet
(Bedrock/S3-recordings integration isn't built), so there's nothing to pass until that exists.

For **local dev**, set `POLLY_CACHE_BUCKET` in the root `.env` to whatever bucket name you're using (run
`ecs-deploy.sh` once to have it create `book-holder-polly-cache-<account-id>` and reuse that name locally, or
create your own bucket manually first). Local Polly calls use the same code path as deployed — no mock — with
credentials resolved from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env` rather than a task role.
