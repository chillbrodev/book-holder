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

## Deploy config (App Runner + Amplify)

Not built yet. Per `docs/ORCHESTRATION_PLAN.md` Week 1, this is still outstanding — no `apps/web`/`apps/api`
exist yet for either service to deploy.
