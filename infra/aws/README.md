# AWS — credentials, budget alert, deploy config

## Credentials (local dev)

Configured via `aws login` (AWS CLI ≥2.32.0), not a static IAM access key: it reuses your AWS Console
sign-in through a browser OAuth flow and caches short-lived credentials (auto-refreshed, ~12h) locally. No
long-lived secret sitting in `~/.aws/credentials` or `.env` to leak or rotate.

```
aws login
```

Currently authorized against the account root session — simplest path for a solo personal AWS account.
Root is unrestricted, so treat this like any other elevated session (don't leave it running unnecessarily,
re-run `aws login` when it expires rather than reaching for a permanent key). If tighter scoping is ever
wanted, an IAM user with the `SignInLocalDevelopmentAccess` managed policy can be used with `aws login`
instead — see the discussion this traded off against in conversation history if picking that up later.

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
`book-holder-api` Express Mode service — idempotent, same pattern as `budget-alert.sh`. Requires Docker and
an authenticated AWS CLI session locally. **This creates real, billed AWS resources (ALB + Fargate task)
the moment the service goes `ACTIVE`** — not a dry run, don't run it casually against a real account.
