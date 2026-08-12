# Orchestration Plan — 3-week build sequencing

Companion to `PROJECT_PLAN.md` §8 (week-by-week) and to `FE_PLAN.md` / `BE_PLAN.md`. This doc breaks the
week-by-week timeline into a day-by-day sequence for a solo builder working with Claude Code, marks each
item **FE**, **BE**, or **Infra**, and flags what can run in parallel versus what's a hard dependency —
so frontend and backend work interleave instead of one blocking the other, and cost/usability/brand aren't
left for a rushed final pass.

---

## Status

*As of August 6 2026. Build started July 21; the deadline is August 18 — day 17 of the plan, roughly twelve
days left.*

**Done — everything of week 1, and the infrastructure half of week 2.** The pipeline runs end to end for a
guest: pick a play, pick a part, pick a scene, and rehearse it with the other characters voiced.

- **Data.** Schema migrated (001–004), `packages/play-importer` built and validated against the real Moby
  XML, Merry Wives imported and verified in the cluster. The corpus is now **1 play, 24 characters, 1,705
  beats in ~1,060 blocks, 193 stage directions** — the row count changed *meaning* in migration 004, not just
  value: a row in `lines` is a beat (one thought), not a line of verse. See `beats-and-blocks-plan.md`.
- **API.** Deno + Hono, deployed. Auth (`/auth/register|login|logout|me`, username + PIN, hashed, with
  lockout), plays (`/plays`, characters, scenes, scene dialogue, a beat and its block), Polly
  (`/polly/blocks/:blockId/audio`), and `/health` returning the deployed commit. Tests cover auth and the
  Polly duration guard.
- **Frontend.** Shelf → play page (part step, then the scenes that part is in) → rehearsal, on real API data
  with real cached audio. Auth is an opt-in "Save Progress" affordance, never a gate in front of the app.
- **Deploy.** Automatic, both halves: `.github/workflows/deploy-api.yml` builds and rolls the ECS Express
  service on any push touching `api/**`, Amplify rebuilds the frontend off the same push. GitHub OIDC, no
  long-lived keys; `COCKROACHDB_URL`/`ALLOWED_ORIGIN` via Secrets Manager. `infra/aws/ecs-deploy.sh` is
  bootstrap-only and stays human-run.
- **Polly.** All ~1,060 blocks warmed and cached in S3, on the **neural** engine after generative was found
  to invent sentences past the end of the text (`docs/polly-gen-issue.md`) — engine is now part of the cache
  key, and a duration guard refuses to cache an implausibly long render.
- **Cost safety net.** AWS Budget alert `book-holder-monthly`, $25/month, email at 80% and 100% actual spend,
  scripted in `infra/aws/budget-alert.sh` (idempotent). Credentials came from `aws login` (short-lived,
  browser-based) rather than a static IAM access key. **Threshold still needs raising to ~$40**
  (`PROJECT_PLAN.md` §9) now that ECS + ALB is the plan.

**Not started — the agent loop itself, which is the whole pitch.** Mic capture, Transcribe, the Bedrock
comparison, transactional session writes, mastery scores, coaching notes, and S3 session recordings. Nothing
in `line_mastery` or `mistake_log` yet; the wrap-up and Prompt Book screens render against
`frontend/src/data/mock/*`. This is week 2's day 3–5 row, and it is now the only thing standing between the
build and a demo. `docs/OPEN_ITEMS.md` §1 holds the open design questions — the fuzzy-match threshold above
all, which wants settling *before* Bedrock is wired, since it determines what the comparison prompt is even
asking for.

**Still outstanding, not dropped**: `packages/shared-types`. The FE and API have kept their own types so far,
which has been survivable at this size, but the comparison flow is exactly where it starts to hurt — the
recording UI and the comparison response shape get developed against each other, and that's the point at
which two hand-maintained copies of a type drift silently. Worth creating when that work starts, rather than
retrofitting after. Backend hosting changed from App Runner to ECS Express Mode
early on (App Runner stopped accepting new customers 2026-04-30 and is now maintenance-only); Express Mode
uses the same billed resources (Fargate + ALB) with far less manual setup.

## Week 1 — Foundation

| Day | Track | Work | Status |
|---|---|---|---|
| 1 | Infra | AWS Budget alert first (cost safety net before any spend-generating work exists) | **Done** — `infra/aws/budget-alert.sh`, $25/month, alerts at 80%/100% actual spend |
| 1 | Infra | CockroachDB `ccloud` CLI provisioning script | **Skipped, not planned** — the cluster (`the-book-holder`) already existed; connected to directly instead of provisioning from scratch. If a from-scratch script is ever needed later, it doesn't exist yet. |
| 1 | Infra | Schema migrations | **Done** — four of them now, applied via `npm run db:migrate`: `001_init_schema.sql`, `002_pin_auth.sql` (username + PIN), `003_polly_voice_id.sql` (voice per character rather than an env var), `004_beats_and_blocks.sql` (destructive — a row in `lines` became a beat, and both embedding columns moved to `VECTOR(1024)`). `PROJECT_PLAN.md` §5 now describes the as-built schema, including why `lines` has no `character_id` and why `stage_directions` exists; `BE_PLAN.md` §1a has the original reasoning. |
| 1 | Infra | npm-workspaces scaffolding | **Done** — root `package.json`, `infra/cockroachdb`, `packages/play-importer`, `frontend`. `api` sits outside the npm workspace on purpose: it's Deno, with its own `deno.json`. `packages/shared-types` still doesn't exist — see the status note above for when it earns its keep. |
| 1 | Infra | Amplify + ECS Express Mode deployed end-to-end with placeholder content | **Done, but late** — Amplify wired day 4 (`8d452df`); the API deploy didn't run for real until day 10 (`8986b49`), and the first real run immediately surfaced OIDC trust and deploy-permission gaps (`bae3415`), then an amd64/arm64 image mismatch that killed the task and silently rolled back (`29949c5`). All of that was the cost of not doing this on day one as the plan said. |
| 2–3 | BE | Play-importer (`packages/play-importer`) against the Merry Wives XML — parsing rules from `PROJECT_PLAN.md` §6 | **Done** — built, tested (caught and fixed two real bugs against the actual source XML: a bad `.map()` call, and 44 silently-dropped mid-speech stage directions), reviewed locally before import, committed |
| 2–3 | FE (parallel) | Picker skeleton (play → role → act/scene) built against mock data — doesn't need to wait on the importer | **Done** — built on fixtures, then moved to the real API (`33e8a99`). Landed as **one play page with two steps** (part, then the scenes that part is actually in) rather than three pages; the old `/role` and `/scenes` URLs redirect so bookmarks don't 404. |
| 4–5 | BE → FE | Wire picker to real imported data once the importer is validated | **Done** — `33e8a99`. Guest-first: no auth gate in front of rehearsing, since auth only exists to persist progress. |

**Hard dependency**: schema must exist before the importer runs; the importer must succeed before the
picker can move off mock data. Everything else in week 1 is parallelizable.

## Week 2 — The agent loop

| Day | Track | Work | Status |
|---|---|---|---|
| 1–2 | BE | Polly voice wiring + per-line caching | **Done, and the caching unit changed** — cached **per block** (one speech, one render), not per line. Rendering a speech in fragments gives each one sentence-final intonation and a trailing pause, audible as stop-start delivery and baked into the cached bytes. Voices are per character in the DB (`characters.polly_voice_id`, migration 003), not an env var. |
| 1–2 | FE (parallel) | Rehearsal UI shell built against stub audio — doesn't need real Polly output yet | **Done** — shell, header, controls and scroll model (`9fce61e`), now rendering real blocks with real cached audio |
| 3–4 | BE + FE (coupled) | Mic recording → Transcribe → Bedrock comparison flow. **Not parallelizable** — the FE recording UI and BE comparison response shape need to be developed against each other, expect tight iteration here, not independent tracks | **Not started — the critical path.** The segmentation that makes it possible is in place: the beat is the scoring unit. Design has moved since this row was written — the mic stays open across a whole *block* at natural pace, with beats as scoring boundaries rather than interaction boundaries, and alignment as a rolling fuzzy match rather than a hard transcript split (`OPEN_ITEMS.md` §1b). Settle the fuzzy-match threshold (§1a) before writing the Bedrock prompt. |
| 5 | BE | Transactional session writes (session + mastery + mistake log), first Bedrock coaching-note call, S3 recording save/playback | **Not started.** Depends on the row above. `packages/play-importer/src/ingest.ts` is the working reference for the Cockroach retry idiom; the S3 wrapper already takes a bucket per call, so recordings reuse it. |

This week is the core demo. If anything slips, it slips from week 3's stretch scope, not from here.

## Week 3 — Memory depth, resilience, polish (buffer)

| Day | Track | Work | Status |
|---|---|---|---|
| 1–2 | BE (stretch) | Vector embeddings + nearest-neighbor mistake-pattern search — ~~cut first if weeks 1–2 ran long~~ | **Shipped August 11 2026, and no longer cuttable — the hackathon requires two CockroachDB tools and this is one of them.** All 1,705 beats embedded (Titan Text Embeddings V2, 1024 dims, 0 failures, 113 s, $0.0006) via `deno task embed-beats`; migration 007 indexes both columns `vector_l2_ops`. Two corrections to what this row used to say: **L2 is a choice, not CockroachDB's only option** — `<->`, `<=>` and `<#>` all work on v26.2.5, verified — so normalizing is right because it makes the operator choice moot, not because there was no choice; and a probe vector passed as a subquery rather than a bound parameter silently plans as a FULL SCAN. `OPEN_ITEMS.md` §2. |
| 3 | BE | Retry/graceful-degradation paths for Bedrock/Polly/Transcribe; re-verify the budget alert is still active and correctly thresholded | **Partly done, for Polly.** Neural throttles far harder than generative did — a first bulk pass at concurrency 6 lost 254 of 1,064 blocks to `ThrottlingException`, and the SDK's default fixed backoff retries straight into the same wall. `retryMode: "adaptive"` with `maxAttempts: 8` and low concurrency fixed it; this applies to the live endpoint too, which synthesizes on miss. Bedrock/Transcribe paths don't exist yet. Budget alert is live but still at $25 — raise to ~$40. |
| 4 | FE | Dedicated usability/brand polish pass — contrast, tap-target, and microcopy refinement. Note: *baseline* accessibility (contrast ratios, target sizes) should already be built in from week 1 per `FE_PLAN.md` §2; this day is for the polish layer on top, not first-pass compliance | **Partly done, opportunistically rather than as a pass.** Real fixes landed as they were found (`7c04de3` part selection resizing the tile and reloading the page, `cae7500` the Continue button pinned to the viewport). Known copy debt: several screens say "lines" while counting beats — `CharacterTile.tsx`, the wrap-up's `linesRun`, `listScenes`' `totalLines` (`OPEN_ITEMS.md` §3). |
| 5 | All | README updates, architecture diagram, demo video/script — explicitly state the "skill model, not fact memory" framing for judges (`PROJECT_PLAN.md` §2) | **Not started.** Docs are current (`PROJECT_PLAN.md`, `OPEN_ITEMS.md`, `polly-gen-issue.md`, `beats-and-blocks-plan.md`); the diagram, video and script are not. |

**Cuttable if time runs short** (in priority order): ~~vector-search mistake-pattern coaching~~ (shipped,
and mandatory — see the judging requirements), admin/"coach's
notes" MCP-backed view. Both are stretch per `PROJECT_PLAN.md` §7 — cutting them doesn't break the MVP.

---

## Dependency summary

- ~~Budget alert → before any paid API call is wired up.~~ Held.
- ~~Schema → importer → real-data picker.~~ Held.
- ~~Polly wiring → rehearsal UI's final (non-stub) polish.~~ Held.
- Mic/Transcribe/Bedrock comparison flow → tightly coupled FE+BE work, not splittable into independent
  tracks like the rest of the timeline. **Still ahead, and now the only hard dependency left.**

**Sequencing from here (as of Aug 6, ~12 days to the deadline).** Everything remaining hangs off one chain,
so the order matters more than it did when work could fan out:

1. **Settle the fuzzy-match threshold** (`OPEN_ITEMS.md` §1a). It costs no code and it decides what the
   comparison prompt asks for; deciding it after Bedrock is wired means rewriting the prompt and rescoring.
2. **Capture → Transcribe → compare**, FE and BE against each other. Mic open per block, beats as scoring
   boundaries.
3. **The transactional write** (session + mastery + mistake log, one serializable transaction with explicit
   retry). This is the row that makes the pitch true rather than aspirational — memory written as a direct
   result of what happened.
4. **Read memory back before a session, and a coaching note after.** Closes the loop the whole submission
   rests on (`PROJECT_PLAN.md` §2).
5. ~~Then, and only then, the stretch: embeddings + vector search~~ — done, and it moved to the
   critical path once the judging requirements landed. What remains here is the demo materials.

Move the wrap-up and Prompt Book off `frontend/src/data/mock/*` as step 3 lands, not before — they need real
mastery rows to read, and fabricated line ids drift further from real data with every change.

## Consolidated tools & docs checklist

Pulled from `FE_PLAN.md` §5–6 and `BE_PLAN.md` §6–8 — check before starting a given week's work.

- **Accounts/CLIs**: AWS CLI configured via `aws login` (short-lived credentials from the root console
  session, not a static access key — see `infra/aws/README.md` for the tradeoff). CockroachDB cluster already
  provisioned and connected — `ccloud` CLI itself not needed unless a from-scratch cluster is ever required.
  AWS Budget alert — **done**, `infra/aws/budget-alert.sh`.
- **Connected**: CockroachDB Cloud MCP server — authorized READ + WRITE, but used read-only in practice; the
  user requires confirmation before every write (`create_database`/`create_table`/`insert_rows`) regardless
  of granted scope. Schema/data changes go through `infra/cockroachdb/migrate.ts` and
  `packages/play-importer`, not MCP.
- **SDKs**: AWS SDK v3 — **Polly and S3 installed and wired** (`api/deno.json`, as `npm:` specifiers, plus
  `s3-request-presigner` for signed cache URLs). Bedrock and Transcribe not installed yet.
- **Testing**: `deno task test` covers the API — auth (PIN hashing, session tokens, routes, service) and the
  Polly duration guard. **No frontend tests exist**, so React Testing Library is still unused; axe
  DevTools / Lighthouse and the manual cross-browser mic/permissions pass are also still ahead, and the mic
  pass can't happen until capture is built.
- **Docs confirmed already**: CockroachDB vector column/index syntax (v25.2+ — and on this cluster the preview gate is already
  open and L2 is *not* the only distance; both of those were wrong here — see
  `infra/cockroachdb/README.md`). Polly voice catalog — confirmed and assigned per character at import
  (`packages/play-importer/src/voices.ts`), Merry Wives only; a play with no list warns loudly rather than
  silently voicing every woman as a man.
- **Docs still to confirm at build time, not from memory**: serializable-transaction retry idiom for the live
  per-session write path (the importer's retry pattern in `packages/play-importer/src/ingest.ts` is a
  reference, not a direct copy — see `BE_PLAN.md` §3); current Bedrock model IDs/pricing for the comparison
  and coaching-note models (the *embedding* model is settled: `amazon.titan-embed-text-v2:0`); Transcribe
  API request/response shape, and whether the built path is streaming or batch — they price differently, and
  `PROJECT_PLAN.md` §9 leans on the per-request minimum. ~~Polly voice catalog~~ — done, see above.
  ~~ECS Express Mode setup~~ — confirmed and scripted,
  `infra/aws/ecs-deploy.sh` (IAM roles, ECR push, create/update-express-gateway-service; default VPC/public
  subnets, no NAT Gateway). ~~Dockerfile for the Deno `api` image~~ — done, `api/Dockerfile`.
