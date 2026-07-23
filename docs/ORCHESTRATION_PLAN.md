# Orchestration Plan — 3-week build sequencing

Companion to `PROJECT_PLAN.md` §8 (week-by-week) and to `FE_PLAN.md` / `BE_PLAN.md`. This doc breaks the
week-by-week timeline into a day-by-day sequence for a solo builder working with Claude Code, marks each
item **FE**, **BE**, or **Infra**, and flags what can run in parallel versus what's a hard dependency —
so frontend and backend work interleave instead of one blocking the other, and cost/usability/brand aren't
left for a rushed final pass.

---

## Status

**Done** (ahead of the original day-by-day order below): CockroachDB schema designed and migrated,
`packages/play-importer` built and tested against the real Merry Wives of Windsor XML, data reviewed locally
and imported — 1 play, 24 characters, 2610 lines, 193 stage directions, verified in the cluster. Root
npm-workspaces scaffolding and `infra/cockroachdb` are in place and committed.

**Not started, and out of the original order**: AWS Budget alert (see call-out below — this was supposed to
be day-1-before-anything-spends and still hasn't happened), Amplify/App Runner deploy, `apps/web`/`apps/api`/
`packages/shared-types` scaffolding, the FE picker itself.

**⚠️ Live gap, not just stale docs**: the AWS Budget alert was sequenced first in this plan specifically as a
cost safety net before spend-generating work. No AWS/Bedrock/Polly/Transcribe work has happened yet, so
nothing's been spent unsafely — but it should be set up before any of that starts, not deferred further.

## Week 1 — Foundation

| Day | Track | Work | Status |
|---|---|---|---|
| 1 | Infra | AWS Budget alert first (cost safety net before any spend-generating work exists) | **Not done — do before any Bedrock/Polly/Transcribe work** |
| 1 | Infra | CockroachDB `ccloud` CLI provisioning script | **Skipped, not planned** — the cluster (`the-book-holder`) already existed; connected to directly instead of provisioning from scratch. If a from-scratch script is ever needed later, it doesn't exist yet. |
| 1 | Infra | Schema migrations | **Done** — `infra/cockroachdb/migrations/001_init_schema.sql`, applied via `npm run db:migrate`. Schema deviates from `PROJECT_PLAN.md` §5 (`line_speakers` many-to-many, `stage_directions` table) — see `BE_PLAN.md` §1a. |
| 1 | Infra | npm-workspaces scaffolding | **Partially done** — root `package.json`, `infra/cockroachdb`, `packages/play-importer` exist. `apps/web`, `apps/api`, `packages/shared-types` do not exist yet. |
| 1 | Infra | Amplify + App Runner deployed end-to-end with placeholder content | **Not done** |
| 2–3 | BE | Play-importer (`packages/play-importer`) against the Merry Wives XML — parsing rules from `PROJECT_PLAN.md` §6 | **Done** — built, tested (caught and fixed two real bugs against the actual source XML: a bad `.map()` call, and 44 silently-dropped mid-speech stage directions), reviewed locally before import, committed |
| 2–3 | FE (parallel) | Picker skeleton (play → role → act/scene) built against mock data — doesn't need to wait on the importer | **Not started.** Real imported data already exists now, so this can likely skip the mock-data step entirely and build against the real API once §4–5 exists. |
| 4–5 | BE → FE | Wire picker to real imported data once the importer is validated | **Not started** — no `apps/api` yet to wire through |

**Hard dependency**: schema must exist before the importer runs; the importer must succeed before the
picker can move off mock data. Everything else in week 1 is parallelizable.

## Week 2 — The agent loop

| Day | Track | Work |
|---|---|---|
| 1–2 | BE | Polly voice wiring + per-line caching |
| 1–2 | FE (parallel) | Rehearsal UI shell built against stub audio — doesn't need real Polly output yet |
| 3–4 | BE + FE (coupled) | Mic recording → Transcribe → Bedrock comparison flow. **Not parallelizable** — the FE recording UI and BE comparison response shape need to be developed against each other, expect tight iteration here, not independent tracks |
| 5 | BE | Transactional session writes (session + mastery + mistake log), first Bedrock coaching-note call, S3 recording save/playback |

This week is the core demo. If anything slips, it slips from week 3's stretch scope, not from here.

## Week 3 — Memory depth, resilience, polish (buffer)

| Day | Track | Work |
|---|---|---|
| 1–2 | BE (stretch) | Vector embeddings + nearest-neighbor mistake-pattern search — cut first if weeks 1–2 ran long |
| 3 | BE | Retry/graceful-degradation paths for Bedrock/Polly/Transcribe; re-verify the budget alert is still active and correctly thresholded |
| 4 | FE | Dedicated usability/brand polish pass — contrast, tap-target, and microcopy refinement. Note: *baseline* accessibility (contrast ratios, target sizes) should already be built in from week 1 per `FE_PLAN.md` §2; this day is for the polish layer on top, not first-pass compliance |
| 5 | All | README updates, architecture diagram, demo video/script — explicitly state the "skill model, not fact memory" framing for judges (`PROJECT_PLAN.md` §2) |

**Cuttable if time runs short** (in priority order): vector-search mistake-pattern coaching, admin/"coach's
notes" MCP-backed view. Both are stretch per `PROJECT_PLAN.md` §7 — cutting them doesn't break the MVP.

---

## Dependency summary

- Budget alert → before any paid API call is wired up.
- Schema → importer → real-data picker.
- Polly wiring → rehearsal UI's final (non-stub) polish.
- Mic/Transcribe/Bedrock comparison flow → tightly coupled FE+BE work, not splittable into independent
  tracks like the rest of the timeline.

## Consolidated tools & docs checklist

Pulled from `FE_PLAN.md` §5–6 and `BE_PLAN.md` §6–8 — check before starting a given week's work.

- **Accounts/CLIs**: AWS CLI (not set up yet), CockroachDB cluster already provisioned and connected —
  `ccloud` CLI itself not needed unless a from-scratch cluster is ever required. AWS Budget alert — **not
  configured yet, still the top-priority gap.**
- **Connected**: CockroachDB Cloud MCP server — authorized READ + WRITE, but used read-only in practice; the
  user requires confirmation before every write (`create_database`/`create_table`/`insert_rows`) regardless
  of granted scope. Schema/data changes go through `infra/cockroachdb/migrate.ts` and
  `packages/play-importer`, not MCP.
- **SDKs**: AWS SDK v3 for Bedrock, Polly, Transcribe, S3 — not installed/wired up yet.
- **Testing**: axe DevTools / Lighthouse (accessibility), React Testing Library (FE components), a request
  client such as curl/Postman/Thunder Client (API endpoints), a manual cross-browser mic/permissions pass —
  none of this applies yet since no FE/API code exists.
- **Docs confirmed already**: CockroachDB vector column/index syntax (v25.2+, preview-gated, L2-only — see
  `infra/cockroachdb/README.md`).
- **Docs still to confirm at build time, not from memory**: serializable-transaction retry idiom for the live
  per-session write path (the importer's retry pattern in `packages/play-importer/src/ingest.ts` is a
  reference, not a direct copy — see `BE_PLAN.md` §3); current Bedrock model IDs/pricing; Polly voice
  catalog; Transcribe API request/response shape; App Runner deploy mode (repo-connected vs. Dockerfile).
