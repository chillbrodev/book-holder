# Backend Plan — `api`

Companion to `PROJECT_PLAN.md`. This doc covers the Deno + Hono rehearsal agent in enough detail to build
against: the endpoint/flow breakdown, the read-decide-act-write loop made concrete, cost controls, and
production-readiness — plus the tools and docs needed to build it.

---

## 0. Status

**Done**: CockroachDB schema migrated (`infra/cockroachdb/migrations/001_init_schema.sql`), Merry Wives of
Windsor imported and verified (1 play, 24 characters, 2610 lines, 193 stage directions). The schema actually
built deviates structurally from `PROJECT_PLAN.md` §5 in two ways (plus one implementation-status note) —
see §1a below. `api` built on Deno + Hono with username+PIN auth (`features/auth`). Dockerfile + ECS Express
Mode deploy scripted (`api/Dockerfile`, `infra/aws/ecs-deploy.sh`), not yet run against a real account.

Polly voice synthesis wired up (`features/polly`, `clients/polly-client`, `clients/s3-client`): per-`GET
/polly/lines/:lineId/audio?characterId=`, cached once per `(lineId, voiceId)` in S3, served back via a signed
URL; falls back to a `VOICE_UNAVAILABLE` error carrying the line text if Polly errors and no cache exists
(§5 below). No auth gate — like `/plays`, rehearsing (including hearing other characters) works fully as a
guest; auth is only for persisting progress, which isn't built yet. Every miss is still a potential billed
AWS call, but the whole play is pre-warmed/cached in S3, so real requests are almost always a cheap cache
hit — revisit the no-auth call if a play is ever added without pre-warming it. Same code path locally
and deployed — credentials come from the AWS SDK's default provider chain (env vars locally, ECS task role
when deployed), not branched in code. `ecs-deploy.sh` now also provisions the Polly cache S3 bucket and a
task role scoped to `polly:SynthesizeSpeech` + bucket read/write/head/list.

Cache key is `{play}/{character}/{blockId}__{voiceId}__{engine}.mp3` (slugified play title and character
name), not a flat `{lineId}/{voiceId}.mp3` — grouped for browsability in the S3 console; see `PollyService`'s
`cacheKey`/
`slugify`. `s3:ListBucket` on the bucket itself (not just object-level actions) is required for this to work
correctly — without it, S3 masks "object doesn't exist" as a generic `403` instead of `404` for a scoped IAM
principal, which breaks cache-miss detection. Confirmed by hitting this directly; both `create-dev-user.sh`
and `ecs-deploy.sh`'s task role grant it.

Local dev's AWS SDK calls (this is not the AWS CLI) cannot use `aws login` sessions — that session type isn't
recognized by the SDK's credential chain. `./infra/aws/create-dev-user.sh` provisions a separate, scoped IAM
user with a permanent key for this; see `infra/aws/README.md`.

Uses the **Generative** engine (not Neural) — Amazon Polly's most expressive/human-like voices; confirmed
available in `us-west-2` (our deploy default). Voice is per-character, stored in `characters.polly_voice_id`
(`infra/cockroachdb/migrations/003_polly_voice_id.sql`), not an env var — `characters` is already play-scoped
in the schema, so this lets two plays' same-named characters carry different voices and lets a voice change
via `UPDATE` rather than an env edit + redeploy. Merry Wives of Windsor is currently assigned British English
neural voices (**Amy**/female, **Brian**/male) per character gender, sourced from
stageagent.com's cast list; unassigned characters fall back to `POLLY_DEFAULT_VOICE_ID` (default `Brian`).
`getLineAudio` now takes `characterId`, not a character name, and joins through `line_speakers` to confirm
the requested character actually speaks the requested line before resolving a voice (§1a).

The picker/rehearsal read flow from §2 is also wired up (`features/plays`): `GET /plays`,
`/plays/:playId/characters`, `/plays/:playId/scenes`, `/plays/:playId/scenes/:act/:scene/dialogue`,
`/plays/:playId/lines/:lineId` — all real CockroachDB reads, no auth gate (same reasoning as Polly above).
`getSceneDialogue` interleaves `lines` and `stage_directions` into one ordered stream (a direction with
`after_line_number = N` sorts immediately before line N) but doesn't compute `isUserLine` — that depends on
which character the browser has locally selected to rehearse as (`selectRole`, still localStorage-only —
`roles_in_progress` isn't wired up), which this endpoint has no notion of. `frontend/src/data/client.ts` now
calls these for real instead of its mock fixtures, and `RehearsalPage.tsx` calls the Polly endpoint directly
for other characters' lines — so Polly is no longer a standalone building block, it's in the real rehearsal
flow now, just without session/mastery writes yet.

**Not started**: Bedrock (comparison + coaching) and Transcribe (listening) integration, session
start/submission/end endpoints, the read-decide-act-write loop itself (the *write* half — reads are wired,
per above). `WrapUpPage`/`PromptBookPage` also still render mock data, since they need mastery data that
doesn't exist server-side yet.

## 1b. Runtime note: Deno + Hono, not Node/Express

- **Deno**, not Node — `api/deno.json` (not `package.json`) manages tasks and imports; npm packages (AWS SDK
  v3 for Bedrock/Polly/Transcribe/S3, `pg`, etc.) are pulled in via `npm:` specifiers directly in
  `deno.json`'s `imports` map or inline `npm:package@version` specifiers, not `npm install`/`node_modules`.
  Root `package.json`'s `dev` script (`concurrently ... npm run dev --workspace=api`) needs `api`'s script to
  shell out to `deno task dev`, since `api` isn't an npm workspace in the Node sense.
- **Hono**, not Express, for routing/middleware — add it to `api/deno.json` imports (`jsr:@hono/hono` or
  `npm:hono`). Hono's built-in `Deno.serve` adapter is a direct fit for the existing `api/main.ts` handler
  shape (`Request` → `Response`), so the migration from the placeholder handler to real routes is additive,
  not a rewrite.
- Local dev already works via `deno task dev` (`--watch --allow-net`) — permissions will need to expand
  (`--allow-env`, `--allow-net` scoped to CockroachDB/AWS endpoints) once real integrations land; Deno's
  explicit permission flags are worth keeping narrow rather than blanket `-A`, both for the "production
  readiness" judging criterion and because it's free defense-in-depth against a compromised dependency.

## 1. Scope

The rehearsal agent is the API layer implementing `PROJECT_PLAN.md` §2's loop: **read memory → decide → act
→ write memory**, on top of CockroachDB (memory), Bedrock (comparison + coaching), Polly (voices),
Transcribe (listening), and S3 (recordings). No AWS credentials ever reach `frontend` — every external call
routes through this layer.

## 1a. Schema deviations from `PROJECT_PLAN.md` §5 (as actually built)

Discovered from the real Merry Wives of Windsor XML during import, not hypothetical:

- **No `lines.character_id`.** Some speeches have more than one `<SPEAKER>` (e.g. PAGE, SHALLOW, and SLENDER
  jointly speaking "Adieu, good master doctor."). `line_speakers` is a many-to-many join
  (`line_id`, `character_id`) instead. **Any query that means "this character's lines" needs a join through
  `line_speakers`, not a `WHERE character_id = ...` filter.**
- **New `stage_directions` table**, not in the original data model: blocking cues ("Enter SHALLOW...",
  "Exeunt", "Knocks"), both between speeches and interleaved mid-speech. Each row has `after_line_number`
  (scene-local) so the app can interleave a cue with the lines around it, not just know its order relative to
  other cues. Not required for MVP rehearsal flow, but there if the rehearsal surface ever wants to surface
  staging cues.
- `lines.embedding` / `mistake_log.embedding` exist as nullable `VECTOR(1536)` columns, left `NULL` by the
  importer on purpose — no embedding model has been wired up yet (see §7/§8).

## 2. Endpoint / flow breakdown

| Flow | What happens |
|---|---|
| Play/role/scene selection | Serve picker data from `plays`/`characters`/`lines`; "this character's lines" requires joining through `line_speakers` (§1a), not a direct FK |
| Session start | **Read** `line_mastery` for the chosen scene → decide what to emphasize (e.g. resurface lines with low confidence or high mistake count) |
| Line playback | Synthesize via Polly if not already cached for that line; serve cached audio otherwise |
| Line submission | Transcribe her recorded line → Bedrock (Nova Micro/Lite) semantic comparison against the script line — not exact match |
| Session end | **Write**, in one serializable transaction: `session_history` insert, `line_mastery` updates, `mistake_log` inserts |
| Coaching note | Bedrock (stronger model) summarizes the session against history — infrequent call, not per-line |
| Recording save/playback | Upload to S3 on session end; serve back via signed URL, never a direct client-to-S3 path |

## 3. The agentic loop, concretely

- **Read-before-decide** happens exactly once per session start — pull `line_mastery` rows for the scene,
  use them to order/weight which lines get emphasis. This is the "reads memory to decide what happens next"
  half of the pitch; don't let it become a static config.
- **Write-after-act** happens in one transaction at session end, not scattered across the request lifecycle.
  Cockroach serializable transactions can abort on conflict — **write the retry loop explicitly** (standard
  Cockroach client-side retry pattern: catch the retry error code, re-run the transaction body, bounded
  retry count). This is called out as a production-readiness signal in `PROJECT_PLAN.md`, not boilerplate to
  skip.
- Periodic/stretch: embed new `mistake_log` rows, run a nearest-neighbor vector search against mistake
  history to surface cross-scene patterns — this is the week 3 stretch item from `PROJECT_PLAN.md` §7.

## 4. Cost-effectiveness

- **Nova Micro/Lite** for the high-frequency per-line comparison call; reserve the stronger Bedrock model
  for the low-frequency session-summary/coaching-note call only.
- **Cache Polly synthesis per line** — synthesize once per (line, voice), reuse on every replay. This is
  both a cost control and a latency win.
- **AWS Budget alert** — done, `infra/aws/budget-alert.sh` ($25/month, 80%/100% actual-spend email alerts),
  set up before any Bedrock/Polly/Transcribe wiring, per the original intent here. **Needs raising** now that
  ECS/Fargate + ALB is the deploy target — realistic always-on hosting cost alone is ~$30/mo before any
  Bedrock/Polly/Transcribe usage; see `PROJECT_PLAN.md` §9 for the full breakdown.
- **ECS/Fargate sizing**: start the task small (0.25 vCPU / 0.5 GB) — Hono is a thin routing layer, the actual
  work (Bedrock/Polly/Transcribe calls) happens in managed AWS services, not in-container compute. Resize
  only if profiling shows the task itself is the bottleneck, not preemptively.
- **Deploy via ECS Express Mode**, not a hand-rolled ECS service/task-definition/ALB — AWS's own recommended
  App Runner replacement now that App Runner is in maintenance mode (stopped accepting new customers
  2026-04-30). Needs only a container image + task execution role + infra role; it auto-provisions the
  Fargate service, ALB w/ SSL, autoscaling, and networking. **Confirmed**: it defaults to the account's
  default VPC + public subnets (no NAT Gateway), matching what we'd have chosen manually — see
  `infra/aws/ecs-deploy.sh`, which scripts the CLI flow AWS documents (IAM role creation, ECR push,
  `create-express-gateway-service`/`update-express-gateway-service`).
- A 1-year Compute Savings Plan (No Upfront) on the Fargate usage is worth taking (~20% off, ~$1.80/mo here)
  but won't move the total much — the ALB Express Mode provisions (not eligible for Savings Plans) is the
  larger fixed cost at this traffic level, not the compute. If a second service is ever added (e.g. an admin
  "coach's notes" view), Express Mode supports sharing one ALB across multiple services on the same
  networking config — worth using rather than paying for a second ALB.
- **Guard against runaway calls**: request timeouts on Bedrock/Polly/Transcribe calls, and don't let a
  client retry loop turn into repeated paid calls (e.g. debounce "play again" against the cache, not a
  fresh synthesis).

## 5. Production readiness

- No AWS keys anywhere in `frontend` — confirmed by code review before demo, not just by convention.
- Retry logic named explicitly for Cockroach transactions (§3 above), not assumed to "just work."
- **Graceful degradation** if an external service is slow/down:
  - Bedrock comparison slow/down → fall back to a simpler exact/fuzzy text match so the session isn't
    blocked, and flag the note as unavailable for that session.
  - Polly slow/down → serve last-cached audio if available; otherwise a clear "voice unavailable, here's
    the line text" fallback (also serves as an accessibility fallback for the older-user audience if audio
    fails).
  - Transcribe slow/down → let her mark the line as "said it" manually rather than blocking on STT.
- These fallbacks double as accessibility fallbacks, not just uptime hedges — worth stating explicitly when
  narrating this for judges.

## 6. Tools

- AWS CLI — configured via `aws login` (short-lived credentials from the root console session, not a static
  access key). See `infra/aws/README.md`.
- CockroachDB `ccloud` CLI — **not scripted into `infra/cockroachdb`**, and not planned to be: the cluster
  (`the-book-holder`, CockroachDB v26.2.1, AWS us-west-2) already existed and was connected to directly
  rather than provisioned by this repo. If a from-scratch provisioning script is ever needed, it isn't built.
- CockroachDB Cloud MCP server — **connected**, authorized with READ + WRITE scope, but the user has asked to
  be checked with before any write (`create_database`/`create_table`/`insert_rows`) every time, regardless of
  scope. In practice: used read-only (`list_tables`, `get_table_schema`, `select_query`, etc.) for
  verification; schema/data writes go through `infra/cockroachdb/migrate.ts` and
  `packages/play-importer` instead, not through MCP.
- Bedrock, Polly, Transcribe, S3 SDKs (AWS SDK for JavaScript v3), pulled into `api` via `npm:` specifiers in
  `deno.json` (Deno consumes npm packages directly, no `node_modules`/`npm install` step). Not installed/wired
  up yet.
- Docker — **done**, `api/Dockerfile` (`denoland/deno:2.9.4` base). Runs as the base image's non-root `deno`
  user throughout the build, not just at runtime — `/app` is `chown`'d to `deno` before anything is copied
  in or `deno install` runs, working around denoland/deno_docker#537 (installing as root then switching users
  right before `CMD` avoids the bug too, but doesn't get non-root's least-privilege benefit during
  dependency resolution). `deno install --frozen` fails the build loudly if `deno.lock` drifts from
  `deno.json` instead of silently re-resolving. `api/.dockerignore` excludes `.env*`/`.git` so local secrets
  can't end up baked into an image layer.
- AWS CLI `ecs` commands (Express Mode is available via console, CLI, SDKs, CloudFormation, Terraform, and
  the AWS Labs ECS MCP Server) for creating the Express Mode service and pushing images to ECR — not
  scripted into `infra/aws` yet. Only three inputs required to stand it up: a container image, a task
  execution role, and an infrastructure role — meaningfully less setup than hand-rolling task
  definitions/ALB/target groups.
- A request client for manual endpoint testing during development (curl, Postman, or Thunder Client) — no
  need for a heavier API-testing framework at this scale.

## 7. Docs to read before/while building

- ~~CockroachDB vector column + distributed vector index syntax~~ — **confirmed** (v25.2+, preview, gated
  behind `SET CLUSTER SETTING feature.vector_index.enabled = true`, L2 distance only). Documented in
  `infra/cockroachdb/README.md`. Still not indexed — `lines.embedding`/`mistake_log.embedding` are populated
  with real vectors first, per that file's TODO.
- CockroachDB serializable transaction retry pattern — confirm the current recommended client-side retry
  idiom for the Node driver in use. `packages/play-importer/src/ingest.ts` has a working example (bounded
  retry on SQLSTATE `40001`) for the one-shot-import case; the live per-session write path needs the fuller
  treatment described in §3 above.
- Current Bedrock model IDs and pricing for Nova Micro/Lite and whichever stronger model is chosen for
  summaries — verify at build time, not from memory (pricing/IDs shift).
- ~~Polly voice catalog~~ — resolved: Generative engine, British English (Amy/Brian), assigned per character
  via `characters.polly_voice_id`. See §0 above.
- Transcribe API docs — confirm request/response shape for post-utterance (non-streaming) transcription.
- **ECS Express Mode docs** — confirm current setup flow (task execution role + infrastructure role
  requirements), and specifically its **default networking** (public subnet vs. NAT Gateway) before deploying
  — see cost note in §4. Also confirm ECR push flow, and how Deno's `npm:`-specifier model interacts with a
  container build (whether to vendor/cache deps at build time vs. resolve on container start) before writing
  the Dockerfile — this is the one part of the Deno switch that's genuinely different from a Node container
  build. Express Mode is AWS's current recommended path (App Runner is in maintenance mode as of
  2026-04-30), so build against it directly rather than a hand-rolled ECS service.
- Deno + Hono docs — confirm current idiomatic pattern for Hono's `Deno.serve` adapter and middleware chain;
  `api/main.ts`'s existing `(req: Request) => Response` handler shape maps directly, but verify at build time
  rather than assuming Express-style middleware patterns carry over.

## 8. Open items to verify

- ~~Exact CockroachDB vector column + index syntax~~ — resolved, see §7.
- Bedrock model IDs and current pricing at build time (carried over from `PROJECT_PLAN.md` §10) — still open.
- ~~MCP Server read-only scoping~~ — resolved differently than assumed: the server itself supports read+write
  and was authorized with both, but the user requires confirmation before every write regardless. Any future
  in-app "coach's notes" view should still default to read-only MCP calls; nothing about that plan changes.
