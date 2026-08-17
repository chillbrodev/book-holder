# Backend Plan — `api`

Companion to `PROJECT_PLAN.md`. This doc covers the Deno + Hono rehearsal agent: the endpoint/flow
breakdown, the read-decide-act-write loop made concrete, cost controls, and production readiness.

**This is a decision record, not a status page.** It says why things are the way they are, and what each
choice cost to learn. It deliberately does not track what is built; the README does that, and a doc that
tracks state is a doc that is wrong within a week. Section numbers are stable because code comments cite
them, so gaps in the numbering are intentional.

---

## 0. Findings that cost something to learn

Kept because each one was paid for once and would otherwise be paid for again.

**The deploy image must be built for arm64.** The ECS service runs on ARM64; an amd64 image dies with
`exec format error` and the service *silently rolls back to the previous revision*, so the deploy looks
like it merely didn't take effect. Related: the service endpoint has to be resolved from `ingressPaths`,
not from a `url` field. Both are fixed in the workflow rather than in a checklist, because a checklist only
protects whoever remembers to read it.

**`s3:ListBucket` on the bucket itself is required, not just object-level actions.** Without it, S3 masks
"object doesn't exist" as a generic `403` rather than `404` for a scoped IAM principal, which breaks
cache-miss detection outright. Confirmed by hitting it directly. Both `create-dev-user.sh` and the task
role grant it.

**Everything that varies the audio must be in the cache key.** The engine was not, originally, which is
exactly how renders from the generative engine survived the switch away from it: a cache hit is an S3
`objectExists`, which proves existence and not validity, and nothing ever re-renders on its own. The key
is `{play}/{character}/{blockId}__{voiceId}__{engine}.mp3`.

**The duration guard is calibrated, not guessed.** `assertPlausibleLength` discards any render more than
1.75× longer than its text can account for. Across 1,064 renders the ratio of actual to estimated duration
has its 99th percentile at **1.47**, while the three known-bad generative renders sat at **2.17, 2.55 and
4.51**. Re-check it if the voices, engine, or speech-rate constants change. Background:
`docs/polly-gen-issue.md`.

**Neural throttles far harder than expected.** The first neural warm of Merry Wives lost **254 of 1,064
blocks** to `ThrottlingException` under the SDK's defaults, because "standard" retry mode's fixed backoff
retries straight into the same wall. The client uses `retryMode: "adaptive"` with `maxAttempts: 8`, and
bulk warming needs low `--concurrency`. This applies to the live endpoint too, which synthesizes on miss.

**Voice assignment belongs at import, not in an `UPDATE`.** Voices live in `characters.polly_voice_id`
rather than an env var, so two plays' same-named characters can differ and a change is a row edit rather
than a redeploy. But a one-shot `UPDATE` survives exactly until the next re-import mints new character
rows, which is how the original assignment was lost. It now happens in
`packages/play-importer/src/voices.ts`. Gender is listed explicitly per play rather than inferred: the
Moby source has no reliable signal, and the failure mode of a guess is voicing a character wrong for an
entire play. A play with no list warns loudly rather than silently voicing every woman as a man.

**The audio endpoint is keyed on the block, not the beat.** One speech is one render. The client sends
only the block id because the grouping lives in the database, assigned at import, and must not be
re-derived from a client-supplied list. `getBlockAudio` takes a `characterId` and joins through
`line_speakers` to confirm that character actually speaks that block before resolving a voice (§1a).

**Rehearsing needs no account.** Like `/plays`, the audio path works fully as a guest; auth exists only to
persist progress. Every cache miss is still a potentially billed AWS call, but the play is pre-warmed, so
real requests are almost always a cheap hit. Revisit that if a play is ever added without pre-warming.

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
  `--allow-read=.env` — api/'s own file, since `deno task` sets CWD to api/ — in every task
  **except** `production`. That omission is load-bearing: ECS injects
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
| Block submission | Transcribe her delivery → Bedrock (Nova Micro) semantic comparison against the expected beat texts — not exact match. **One call per block, returning a result per beat**: the mic stays open across a whole *block* and beats are scoring boundaries, not interaction boundaries (`OPEN_ITEMS.md` §1b), so the block is what the model can actually judge in context. Comparison runs against `beat.text`, not `source_lines` — she speaks continuously, so lineation isn't audible and has no place in a transcript diff |
| Per-block coaching | Scored when the block finishes, on the capture socket, and shown under the block as *solid*/*close*/*dry* (`coaching-plan.md`). Written incrementally for a signed-in user; shown but not persisted for a guest |
| Session end | **Write** the scene summary and close the session. Note this is no longer one big transaction at the end — the session row is created at rehearsal *start* and each block's results are written as it completes, because a loop of network calls inside an open serializable transaction is not a thing to build (`coaching-plan.md` §6) |
| Coaching note | Bedrock (stronger model) summarizes the session against history — infrequent call, not per-line. **Generated once and stored** on `session_history`, not regenerated per view: regenerating bills a call on every refresh and produces different words for the same rehearsal |
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

- **Nova Micro** for the high-frequency comparison call; reserve the stronger Bedrock model for the
  low-frequency session-summary/coaching-note call only. Micro rather than Lite because the comparison is
  text against text — there is no image in it — and Micro is the faster of the two.

  **The model id is `us.amazon.nova-micro-v1:0`, and the `us.` prefix is required, not optional.** Nova Micro
  has no in-region presence in `us-west-2` (AWS's model card lists us-west-2 as In-Region ✗ / Geo ✓), so it
  is reachable from this deployment only through the US geo inference profile. Two knock-on effects worth
  holding: IAM must grant `bedrock:InvokeModel` on the profile ARN **and** on the foundation-model ARN in
  every region the profile routes to (us-east-1/us-east-2/us-west-2), and this is the opposite of the rule
  for models that have no profile at all, where the bare id is the only thing that works.

  **The call is per block, not per beat** (`coaching-plan.md` §2), which is a ~1.6× reduction on its own —
  ~1,636 beats live in 1,060 blocks — before prompt caching. Nova supports caching on `system` with a
  5-minute TTL and a 1K-token minimum; the rubric is identical for every block in a scene and blocks land
  well inside five minutes of each other, so the checkpoint hits in practice rather than in theory.

  **Bedrock pricing for current models is still unverified.** AWS's pricing page renders no figures for Nova
  or for any current-generation model when fetched, so §7's "verify pricing at build time" below is
  genuinely outstanding rather than quietly satisfied. Do not substitute first-party Anthropic rates —
  Bedrock is separately priced.
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
  - **Supabase slow/down → almost nothing happens**, and that is a property of the design rather than
    luck. Verification is offline: the API checks a signature against a JWKS it fetched once and cached,
    so a signed-in actor keeps rehearsing, keeps being scored, and keeps having it written down through
    an outage. Only *new* sign-ins fail, and a guest can rehearse anyway. The one thing that would break
    this is verifying by calling `/auth/v1/user` per request instead — which is why it doesn't.
- These fallbacks double as accessibility fallbacks, not just uptime hedges — worth stating explicitly when
  narrating this for judges.
- **No auth secret is deployed at all.** Passwords, lockout and session lifetime are Supabase's; the API
  holds only the project URL, because ES256 verification needs the public key and nothing else. The
  `sb_secret_…` admin key — which can read and rewrite every user — is deliberately absent from the task
  definition, so compromising the container does not compromise any account.
