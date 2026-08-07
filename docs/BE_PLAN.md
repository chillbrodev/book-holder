# Backend Plan — `api`

Companion to `PROJECT_PLAN.md`. This doc covers the Deno + Hono rehearsal agent in enough detail to build
against: the endpoint/flow breakdown, the read-decide-act-write loop made concrete, cost controls, and
production-readiness — plus the tools and docs needed to build it.

---

## 0. Status

**Done**: CockroachDB schema migrated — four migrations now (`001_init_schema.sql`, `002_pin_auth.sql`,
`003_polly_voice_id.sql`, `004_beats_and_blocks.sql`) — and Merry Wives of Windsor imported and verified:
1 play, 24 characters, **1,705 beats in ~1,060 blocks**, 193 stage directions. That row count is not the
2,610 this doc used to quote: migration 004 changed what a row in `lines` *is*, from a line of verse to a
**beat** (one thought). See §1a below and `docs/beats-and-blocks-plan.md`. `api` built on Deno + Hono with
username+PIN auth (`features/auth`).

**Deployed, and deploying itself.** `.github/workflows/deploy-api.yml` builds `api/Dockerfile` and rolls the
ECS Express service on every push to `main` touching `api/**`, authenticating through GitHub's OIDC provider
rather than stored keys, with `COCKROACHDB_URL`/`ALLOWED_ORIGIN` delivered by Secrets Manager (the workflow
passes the secret ARN and never reads the values). `infra/aws/ecs-deploy.sh` is **not** that path — it
bootstraps IAM roles, the S3 cache bucket and the service itself, and stays local and human-run rather than
handing CI `iam:CreateRole`. `GET /health` returns the deploying commit as `{version}` so a rollout can be
verified against `git rev-parse --short HEAD` rather than assumed from a 200. Two things the first real runs
taught, both now fixed in the workflow rather than in a checklist: the image must be built on an arm64 runner
to match the service's ARM64 platform (an amd64 image dies with `exec format error` and the service silently
rolls back to the previous revision), and the service endpoint has to be resolved from `ingressPaths` rather
than a `url` field.

Polly voice synthesis wired up (`features/polly`, `clients/polly-client`, `clients/s3-client`): `GET
/polly/blocks/:blockId/audio?characterId=`, cached in S3 per `(block, voice, engine)` and served back via a
signed URL; falls back to a `VOICE_UNAVAILABLE` error carrying the block text if Polly errors and no cache
exists (§5 below). **The endpoint is keyed on the block, not the beat** — one speech is one render, and the
client sends only the block id, because the grouping lives in the database (assigned at import) and must not
be re-derived from a client-supplied list. No auth gate — like `/plays`, rehearsing (including hearing other
characters) works fully as a guest; auth is only for persisting progress, which isn't built yet. Every miss
is still a potential billed AWS call, but the whole play is pre-warmed/cached in S3, so real requests are
almost always a cheap cache hit — revisit the no-auth call if a play is ever added without pre-warming it.
Same code path locally and deployed — credentials come from the AWS SDK's default provider chain (env vars
locally, ECS task role when deployed), not branched in code. `ecs-deploy.sh` also provisions the Polly cache
S3 bucket and a task role scoped to `polly:SynthesizeSpeech` + bucket read/write/head/list.

Cache key is `{play}/{character}/{blockId}__{voiceId}__{engine}.mp3` (slugified play title and character
name), not a flat `{lineId}/{voiceId}.mp3` — grouped for browsability in the S3 console; see `PollyService`'s
`cacheKey`/`slugify`. **The engine is in the key deliberately, and everything that varies the audio must
be.** It wasn't originally, which is exactly how renders from the generative engine survived the switch away
from it: a cache hit is an S3 `objectExists` — existence, not validity — and nothing re-renders on its own,
so changing the engine alone could not dislodge them. `synthesizeAndCache` also guards duration
(`assertPlausibleLength`): a render more than 1.75× longer than its text can account for is discarded rather
than cached. That threshold is calibrated against the corpus, not guessed — across 1,064 renders the ratio
of actual to estimated duration has its 99th percentile at 1.47, while the three known-bad renders sat at
2.17, 2.55 and 4.51. Re-check it if the voices, engine, or speech-rate constants change.

`s3:ListBucket` on the bucket itself (not just object-level actions) is required for this to work
correctly — without it, S3 masks "object doesn't exist" as a generic `403` instead of `404` for a scoped IAM
principal, which breaks cache-miss detection. Confirmed by hitting this directly; both `create-dev-user.sh`
and `ecs-deploy.sh`'s task role grant it.

Local dev's AWS SDK calls (this is not the AWS CLI) cannot use `aws login` sessions — that session type isn't
recognized by the SDK's credential chain. `./infra/aws/create-dev-user.sh` provisions a separate, scoped IAM
user with a permanent key for this; see `infra/aws/README.md`.

Uses the **Neural** engine, and must not go back to Generative. Generative is the more expressive engine and
was used here first for that reason, but it is LLM-based and non-deterministic: the same string renders
differently on every call, and occasionally it doesn't stop at the end of the text. Three blocks were cached
with invented sentences spoken after the real line — Evans's "The dozen white louses…" came back as 21.2s
against a ~9s baseline, with a fabricated line about Saint George on the end. Neural returns byte-identical
audio for identical input (verified: three runs of the same line, same md5), so a render cannot drift into
invention, and it is cheaper — $16 vs $30 per 1M characters, against a 1M-character monthly free tier rather
than generative's 100K. Full write-up in `docs/polly-gen-issue.md`. Neural also **throttles far harder**: the
first neural warm of Merry Wives lost 254 of 1,064 blocks to `ThrottlingException` under the SDK's defaults,
because "standard" retry mode's fixed backoff retries straight into the same wall. The client uses
`retryMode: "adaptive"` with `maxAttempts: 8`, and bulk warming needs low `--concurrency` — this applies to
the live endpoint too, which synthesizes on miss.

Voice is per-character, stored in `characters.polly_voice_id`
(`infra/cockroachdb/migrations/003_polly_voice_id.sql`), not an env var — `characters` is already play-scoped
in the schema, so this lets two plays' same-named characters carry different voices and lets a voice change
via `UPDATE` rather than an env edit + redeploy. Merry Wives of Windsor is assigned British English voices
(**Amy**/female, **Brian**/male) per character gender, sourced from stageagent.com's cast list; unassigned
characters fall back to `POLLY_DEFAULT_VOICE_ID` (default `Brian`). The assignment now happens **at import**
(`packages/play-importer/src/voices.ts`), not by a one-shot `UPDATE` — an UPDATE survives exactly until the
next re-import mints new character rows, which is how the original assignment was lost. Gender is listed
explicitly per play rather than guessed: the Moby source has no reliable signal, and the failure mode of a
guess is voicing a character wrong for a whole play. A play with no list warns loudly rather than silently
voicing every woman as a man. `getBlockAudio` takes `characterId`, not a character name, and joins through
`line_speakers` to confirm the requested character actually speaks the requested block before resolving a
voice (§1a).

The picker/rehearsal read flow from §2 is also wired up (`features/plays`): `GET /plays`,
`/plays/:playId/characters`, `/plays/:playId/scenes` (optional `?characterId=` adds that character's per-scene
beat count, so the scene picker can lead with the scenes their part is actually in),
`/plays/:playId/scenes/:act/:scene/dialogue`, `/plays/:playId/lines/:lineId`, and
`/plays/:playId/lines/:lineId/block` (the block a beat belongs to — what the Prompt Book's single-beat drill
opens, so she practises the thought with its run-up rather than in isolation) — all real CockroachDB reads,
no auth gate (same reasoning as Polly above).
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
doesn't exist server-side yet. The open design questions in front of that work — the fuzzy-match threshold
above all, which decides what the comparison prompt is even asking for — are in `docs/OPEN_ITEMS.md` §1.

## 1b. Runtime note: Deno + Hono, not Node/Express

- **Deno**, not Node — `api/deno.json` (not `package.json`) manages tasks and imports; npm packages (AWS SDK
  v3 for Bedrock/Polly/Transcribe/S3, `pg`, etc.) are pulled in via `npm:` specifiers directly in
  `deno.json`'s `imports` map or inline `npm:package@version` specifiers, not `npm install`/`node_modules`.
  `api` is deliberately **not** an npm workspace member, so root `package.json`'s `dev` script shells out
  directly: `concurrently … "cd api && deno task dev"`. Don't reach for `npm` inside `api/`, or `deno`
  outside it.
- **Hono**, not Express, for routing/middleware — `jsr:@hono/hono` in `api/deno.json`. Done; routes are
  organized by feature (`features/auth`, `features/plays`, `features/polly`, `features/app`), each exporting
  a `Hono` sub-app.
- Permissions stay narrow rather than blanket `-A`: `--allow-net --allow-env --allow-sys=osRelease`, plus
  `--allow-read=../.env` in every task **except** `production`. That omission is load-bearing — ECS injects
  the task definition's environment directly, so there's no `.env` to read, and Deno checks permission
  *before* file existence, so an unconditional `loadSync` would throw `PermissionDenied` on every boot
  instead of the graceful no-op a missing file gets. `ConfigClient` skips the load entirely when
  `DENO_ENV=production`.

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
- **A row in `lines` is a beat, not a line of verse** (migration 004, `docs/beats-and-blocks-plan.md`). The
  beat is one thought — what the coach scores and what `line_mastery` keys on. The unit of *display* and of a
  *single Polly render* is the **block**: one speech, cut wherever a stage direction falls inside it, grouped
  by `block_id`. Score per beat; render and display per block. Practical consequences for query-writing:
  `lines.line_number` is now the scene-local **beat** sequence despite its name (as is
  `stage_directions.after_line_number`), `source_lines`/`is_verse` carry the original lineation because verse
  is memorized by it and the joined `text` can't reproduce it, and any count over `lines` is a beat count.
- **Row ids are content-derived** — UUIDv5 over play/act/scene/speakers/text
  (`packages/play-importer/src/ids.ts`), not `randomUUID()`. Re-importing unchanged text produces the same
  ids, so the Polly cache and practice history survive; changed text produces new ids, so it re-renders and
  re-learns. The namespace constant must never change.
- `lines.embedding` / `mistake_log.embedding` exist as nullable `VECTOR(1024)` columns — 1024 is Titan Text
  Embeddings V2's width; migration 004 moved them off `VECTOR(1536)`, which was Titan **G1**'s. The column
  must match the model exactly or every insert fails. Left `NULL` by the importer on purpose — no embedding
  model has been wired up yet (see §7/§8).
- **`pg` returns 64-bit INTs as strings**, not numbers, to avoid precision loss. Raw row types say
  `number | string` and the `Number()` calls at mapping boundaries are deliberate, not decoration. Aggregate
  columns shared across queries live in constants (`BEAT_COLUMNS`, `SPEAKER_COLUMNS` in
  `features/plays/service.ts`) because several queries feed one mapper — a column added to only some of them
  arrives as `undefined` at runtime rather than failing to compile.

## 2. Endpoint / flow breakdown

| Flow | What happens |
|---|---|
| Play/role/scene selection | Serve picker data from `plays`/`characters`/`lines`; "this character's lines" requires joining through `line_speakers` (§1a), not a direct FK |
| Session start | **Read** `line_mastery` for the chosen scene → decide what to emphasize (e.g. resurface lines with low confidence or high mistake count) |
| Block playback | Synthesize via Polly if not already cached for that block/voice/engine; serve cached audio otherwise. One speech, one render — never per beat |
| Beat submission | Transcribe her delivery → Bedrock (Nova Micro/Lite) semantic comparison against the expected beat text — not exact match. The mic stays open across a whole *block*; beats are scoring boundaries, not interaction boundaries (`OPEN_ITEMS.md` §1b). Comparison runs against `beat.text`, not `source_lines` — she speaks continuously, so lineation isn't audible and has no place in a transcript diff |
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

- **Nova Micro/Lite** for the high-frequency per-beat comparison call; reserve the stronger Bedrock model
  for the low-frequency session-summary/coaching-note call only.
- **Cache Polly synthesis per block** — synthesize once per (block, voice, engine), reuse on every replay.
  Cost control, latency win, and the only way the audio sounds like a speech rather than a series of
  fragments. Done: the whole play is warmed. `deno task warm-polly-cache` is billed and **defaults to a dry
  run** — keep it that way, and keep it keying identically to `getBlockAudio` or the entire paid pass is
  wasted. Nothing enforces that pairing today; a test comparing the two queries would be cheap
  (`OPEN_ITEMS.md` §4).
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
  `deno.json` (Deno consumes npm packages directly, no `node_modules`/`npm install` step). **Polly, S3 and
  `s3-request-presigner` are installed and wired**; Bedrock and Transcribe are not.
- Docker — **done**, `api/Dockerfile` (`denoland/deno:2.9.4` base). Runs as the base image's non-root `deno`
  user throughout the build, not just at runtime — `/app` is `chown`'d to `deno` before anything is copied
  in or `deno install` runs, working around denoland/deno_docker#537 (installing as root then switching users
  right before `CMD` avoids the bug too, but doesn't get non-root's least-privilege benefit during
  dependency resolution). `deno install --frozen` fails the build loudly if `deno.lock` drifts from
  `deno.json` instead of silently re-resolving. `api/.dockerignore` excludes `.env*`/`.git` so local secrets
  can't end up baked into an image layer.
- AWS CLI `ecs` commands (Express Mode is available via console, CLI, SDKs, CloudFormation, Terraform, and
  the AWS Labs ECS MCP Server) for creating the Express Mode service and pushing images to ECR — **scripted**,
  `infra/aws/ecs-deploy.sh` for bootstrap and `.github/workflows/deploy-api.yml` for the recurring deploy.
  Only three inputs are required to stand it up: a container image, a task execution role, and an
  infrastructure role — meaningfully less setup than hand-rolling task definitions/ALB/target groups.
  `infra/aws/github-oidc-bootstrap.sh` and `infra/aws/secrets-bootstrap.sh` are the one-time companions,
  creating the deploy role and moving `COCKROACHDB_URL`/`ALLOWED_ORIGIN` into Secrets Manager.
- A request client for manual endpoint testing during development (curl, Postman, or Thunder Client) — no
  need for a heavier API-testing framework at this scale.

## 7. Docs to read before/while building

- ~~CockroachDB vector column + distributed vector index syntax~~ — **confirmed** (v25.2+, preview, gated
  behind `SET CLUSTER SETTING feature.vector_index.enabled = true`, L2 distance only). Documented in
  `infra/cockroachdb/README.md`. Still not indexed — `lines.embedding`/`mistake_log.embedding` are populated
  with real vectors first, per that file's TODO. The model is settled: Titan Text Embeddings V2
  (`amazon.titan-embed-text-v2:0`), 1024 dimensions, embedded per beat. Leave Titan's `normalize` at its
  default `true` — embedding models are trained for *cosine* distance and CockroachDB offers only *L2*; the
  two rank identically only if every vector is unit-length, so turning normalization off silently degrades
  every nearest-neighbour result rather than erroring (`OPEN_ITEMS.md` §2).
- CockroachDB serializable transaction retry pattern — confirm the current recommended client-side retry
  idiom for the Node driver in use. `packages/play-importer/src/ingest.ts` has a working example (bounded
  retry on SQLSTATE `40001`) for the one-shot-import case; the live per-session write path needs the fuller
  treatment described in §3 above.
- Current Bedrock model IDs and pricing for Nova Micro/Lite and whichever stronger model is chosen for
  summaries — verify at build time, not from memory (pricing/IDs shift).
- ~~Polly voice catalog~~ — resolved: **Neural** engine, British English (Amy/Brian), assigned per character
  at import into `characters.polly_voice_id`. See §0 above and `docs/polly-gen-issue.md`.
- Transcribe API docs — confirm request/response shape, and settle **streaming vs post-utterance** first: the
  capture design in `OPEN_ITEMS.md` §1b wants streaming partials to keep a beat cursor, which is what lets
  "Line?" feed the *next beat* rather than the whole speech. The two price differently, and
  `PROJECT_PLAN.md` §9 leans on the per-request 15-second minimum, so the cost line needs redoing once this
  is decided.
- ~~**ECS Express Mode docs**~~ — confirmed and built. Default networking is the account's default VPC and
  public subnets (no NAT Gateway), matching what we'd have chosen; ECR push and
  `create`/`update-express-gateway-service` are scripted. Deps are resolved at build time via
  `deno install --frozen`, which fails the build loudly if `deno.lock` drifts from `deno.json` rather than
  silently re-resolving.
- ~~Deno + Hono docs~~ — confirmed and built; see §1b.
- **The rollout gap is real and worth knowing before trusting a deploy**: a green workflow run means the new
  version is *answering*, not that the old one has drained. Both revisions serve behind the same endpoint for
  a minute or two, so a request right after a green check can still hit the old code — which matters most on
  the `/polly` cache-miss path. Watch the rollout in the ECS console when it matters. A wait-for-drain step
  was tried in the workflow and reverted: CI doesn't hold the permission to make that call.

## 8. Open items to verify

- ~~Exact CockroachDB vector column + index syntax~~ — resolved, see §7.
- Bedrock model IDs and current pricing at build time (carried over from `PROJECT_PLAN.md` §10) — still open.
- ~~MCP Server read-only scoping~~ — resolved differently than assumed: the server itself supports read+write
  and was authorized with both, but the user requires confirmation before every write regardless. Any future
  in-app "coach's notes" view should still default to read-only MCP calls; nothing about that plan changes.
