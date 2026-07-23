# Backend Plan — `apps/api`

Companion to `PROJECT_PLAN.md`. This doc covers the Node/Express rehearsal agent in enough detail to build
against: the endpoint/flow breakdown, the read-decide-act-write loop made concrete, cost controls, and
production-readiness — plus the tools and docs needed to build it.

---

## 0. Status

**Done**: CockroachDB schema migrated (`infra/cockroachdb/migrations/001_init_schema.sql`), Merry Wives of
Windsor imported and verified (1 play, 24 characters, 2610 lines, 193 stage directions). The schema actually
built deviates structurally from `PROJECT_PLAN.md` §5 in two ways (plus one implementation-status note) —
see §1a below.

**Not started**: `apps/api` itself — no Express server, no endpoints, no Bedrock/Polly/Transcribe/S3
integration yet. Everything in this doc past §1a is still a plan, not built.

## 1. Scope

The rehearsal agent is the API layer implementing `PROJECT_PLAN.md` §2's loop: **read memory → decide → act
→ write memory**, on top of CockroachDB (memory), Bedrock (comparison + coaching), Polly (voices),
Transcribe (listening), and S3 (recordings). No AWS credentials ever reach `apps/web` — every external call
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
- **AWS Budget alert set up on day one**, not as a week-3 afterthought — before any spend-generating call is
  wired up.
- **Guard against runaway calls**: request timeouts on Bedrock/Polly/Transcribe calls, and don't let a
  client retry loop turn into repeated paid calls (e.g. debounce "play again" against the cache, not a
  fresh synthesis).

## 5. Production readiness

- No AWS keys anywhere in `apps/web` — confirmed by code review before demo, not just by convention.
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

- AWS CLI, configured against the hackathon AWS account. Not set up yet.
- CockroachDB `ccloud` CLI — **not scripted into `infra/cockroachdb`**, and not planned to be: the cluster
  (`the-book-holder`, CockroachDB v26.2.1, AWS us-west-2) already existed and was connected to directly
  rather than provisioned by this repo. If a from-scratch provisioning script is ever needed, it isn't built.
- CockroachDB Cloud MCP server — **connected**, authorized with READ + WRITE scope, but the user has asked to
  be checked with before any write (`create_database`/`create_table`/`insert_rows`) every time, regardless of
  scope. In practice: used read-only (`list_tables`, `get_table_schema`, `select_query`, etc.) for
  verification; schema/data writes go through `infra/cockroachdb/migrate.ts` and
  `packages/play-importer` instead, not through MCP.
- Bedrock, Polly, Transcribe, S3 SDKs (AWS SDK for JavaScript v3). Not installed/wired up yet.
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
- Polly voice catalog — confirm neural voice availability per target character before building
  `POLLY_VOICE_MAP`.
- Transcribe API docs — confirm request/response shape for post-utterance (non-streaming) transcription.
- AWS App Runner deploy docs — repo-connected vs. Dockerfile-based deploy, whichever `infra/aws` ends up
  using.

## 8. Open items to verify

- ~~Exact CockroachDB vector column + index syntax~~ — resolved, see §7.
- Bedrock model IDs and current pricing at build time (carried over from `PROJECT_PLAN.md` §10) — still open.
- ~~MCP Server read-only scoping~~ — resolved differently than assumed: the server itself supports read+write
  and was authorized with both, but the user requires confirmation before every write regardless. Any future
  in-app "coach's notes" view should still default to read-only MCP calls; nothing about that plan changes.
