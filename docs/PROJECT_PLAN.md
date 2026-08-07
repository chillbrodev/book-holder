# The Book Holder
 
*A rehearsal partner with a memory, for actors without a scene partner on demand.*
 
Built for: CockroachDB × AWS Hackathon — "Build with Agentic Memory"
Deadline: August 18, 2026
Team: solo, part-time, ~2-3 weeks
Stack: React + Vite, Deno + Hono (`api`), CockroachDB (Serverless), AWS (Bedrock, Polly, Transcribe, S3, ECS/Fargate, Amplify)
Focus play: *The Merry Wives of Windsor* (Moby Shakespeare text, Bosak XML markup — see §6), built to expand
to other plays later.
 
---
 
## 1. The story (lead with this in the pitch)
 
An actress returning to her original career late in life, focused on Shakespeare. She needs a scene partner to rehearse lines, but her real-life partner isn't available on her schedule and isn't always in the mood to read Shakespeare on demand. The Book Holder is that partner: it voices every other character, listens to her lines, remembers what she's mastered and what she hasn't, and tells her what to work on next time.
 
The name is real theater history — the "book holder" was the person backstage in Shakespeare's own company who held the script and fed actors their forgotten lines. This app does the same job with an AI that has a memory.
 
This generalizes beyond one household: community theater actors, drama students, ESL learners practicing dialogue, anyone who can't easily get a live rehearsal partner together on their schedule.
 
---
 
## 2. What makes this "agentic memory" and not just "an app with a database"
 
The category explicitly wants memory to be the mechanism, not a side effect. The design principle:
**the agent reads memory to decide what happens next, and writes memory as a direct result of what happened** —
not just logging for a dashboard.
 
- Before a session: agent reads her per-**beat** mastery scores for the chosen scene and decides what to
  emphasize. (A beat is one thought, and is the unit of scoring throughout — see §5.)
- During a session: her spoken line is transcribed and semantically compared to the script (not exact match —
  actors misremember words, not just skip them).
- After a line/scene: mastery scores update, in the same transaction as the session record.
- Periodically: the agent embeds new mistakes and does a nearest-neighbor vector search against her mistake
  history to find patterns ("she tends to lose the thread in long verse speeches, not just this one scene") and
  proactively recommends what to rehearse next time.
That loop — read memory → decide → act → write memory — is the whole pitch. Protect it above all other features.
 
---
 
## 3. Judging criteria → concrete design decisions
 
| Criterion | What it wants | What we do about it |
|---|---|---|
| Agentic Memory Design | CockroachDB doing more than toy queries | Multi-table serializable transactions on every session write (session + line mastery + mistake log together); memory is read before every session to shape behavior, not just displayed after the fact |
| Technical Implementation | Quality use of vector index, MCP Server, ccloud CLI | Vector index used for real nearest-neighbor mistake-pattern search; MCP Server used read-only during dev (and optionally a "coach's notes" admin view) — connected and authorized READ+WRITE, used read-only in practice, with every write confirmed first; schema and data changes go through `infra/cockroachdb/migrate.ts` and `packages/play-importer`, not MCP. **ccloud CLI: skipped, not planned** — the `the-book-holder` cluster already existed and is connected to directly, so there is nothing to provision from scratch; a provisioning script doesn't exist |
| Real-World Impact | Meaningful use case, not just a demo | Lead pitch with the actress's story; generalize to community theater / drama students / ESL practice |
| Production Readiness | Security, observability, resilience, cost control | No keys in client code; retry logic around Cockroach serializable transactions; graceful degradation if Bedrock/Polly are slow or down; AWS Budget alert. Built so far: no long-lived AWS keys anywhere — GitHub OIDC for deploys, Secrets Manager for `COCKROACHDB_URL`/`ALLOWED_ORIGIN`, signed URLs rather than public S3 objects; hashed PINs with lockout; `GET /health` returning the deployed commit so a rollout can be verified rather than assumed; adaptive retry against Polly's throttling; and a duration guard that refuses to cache an implausibly long render (`docs/polly-gen-issue.md`) |
| Creativity & Originality | Genuine insight into agentic systems | Explicitly frame memory as a *skill/mastery model over time*, closer to spaced repetition for embodied performance than to chatbot fact-memory — say this out loud in the submission, don't leave it implicit |
 
---
 
## 4. Architecture
 
```
React + Vite client (mic, playback, UI)
        |
        v
Rehearsal agent — Deno + Hono API, Dockerized, on AWS ECS Express Mode
(Fargate-based, auto-provisions its own ALB w/ SSL — required:
getUserMedia/mic capture needs a secure context)
        |
   -----------------------------------------------
   |            |                |               |
CockroachDB   Bedrock        Polly + Transcribe   S3
(memory +     (coaching      (character voices,   (session
 vectors)      LLM)           listening)           recordings)
```
 
- **Frontend hosting:** AWS Amplify Hosting (connects to GitHub repo, auto-builds on push)
- **Backend hosting:** AWS **ECS Express Mode**, `api` built as a Docker image (Deno + Hono), pushed to ECR.
  Express Mode is AWS's own recommended App Runner replacement (App Runner stopped accepting new customers
  2026-04-30 and is now in maintenance-only mode) — it needs only a container image + task execution role +
  infrastructure role, and auto-provisions the Fargate service, ALB, SSL, autoscaling, and networking that
  would otherwise be hand-configured. **Same underlying billed resources as a manually-configured ECS
  service** (Fargate compute + ALB + CloudWatch + data transfer, per AWS's own pricing page for Express Mode
  — "no additional charge for using Express Mode itself"), so the cost estimate in §9 doesn't change; what
  changes is build time, not bill. **Confirmed** (AWS CLI walkthrough): Express Mode defaults to an
  internet-facing ALB in the account's **default VPC and public subnets** — no NAT Gateway in the default
  path, so the ~$33/mo NAT concern doesn't apply unless custom subnets are specified later.
- One Express Mode detail worth knowing if a second service is ever added (e.g. the stretch "coach's notes"
  admin view): AWS explicitly supports **sharing one ALB across multiple Express Mode services** on the same
  networking config, which would spread that ~$20/mo fixed cost across services instead of duplicating it —
  not relevant for the single-service MVP, but a reason not to worry about ALB cost scaling linearly if scope
  grows.
- **Database:** CockroachDB Serverless (free tier comfortably covers single-user hackathon scale)
- **LLM:** Amazon Nova Micro/Lite for per-beat comparison (cheap, high volume); a stronger model only for
  less-frequent session-summary/coaching-note generation
- **Voice:** Amazon Polly neural voices, one voice ID per character (`characters.polly_voice_id`, not an
  env var — see `BE_PLAN.md` §0), cached **per block** — one speech, one render. Not per beat and not per
  line of verse: rendering a speech in fragments gives each one sentence-final intonation and a trailing
  pause, which is audible as stop-start delivery and is baked into the cached bytes
  (`beats-and-blocks-plan.md` §1). Engine is pinned to `neural` and belongs in the cache key —
  see `docs/polly-gen-issue.md` and §9 below
- **Listening:** Amazon Transcribe, processing her recorded line after she finishes speaking (not live streaming —
  cut for time/risk; live STT is a stretch goal, not MVP)
- **Storage:** S3, two uses. Built today: the **Polly block cache**, keyed
  `{play}/{character}/{blockId}__{voiceId}__{engine}.mp3` and served to the client as a signed URL rather
  than a public object. Still to come: session recordings (her voice, or her + AI voices), IN the MVP per
  project scope. `S3Client` takes the bucket per call so the same wrapper covers both.
- **Accounts:** username + PIN, built (`api/src/features/auth`, migration `002_pin_auth.sql`). Deliberately
  not Cognito — with multi-user rehearsal cut (§7), all that's needed is enough identity to attribute
  `session_history` / `line_mastery` / `mistake_log` rows to a person. PINs are hashed, attempts are
  rate-limited by a lockout column, and a logged-in browser session is a row in `auth_sessions` — named
  distinctly from `session_history`, which means a *rehearsal* session.
- **Deploy:** automatic, off `main`. A push touching `api/**` runs `.github/workflows/deploy-api.yml`
  (build → ECR → roll the ECS Express service); Amplify rebuilds the frontend off the same push,
  independently. No manual step. Credentials come from GitHub's OIDC provider assuming an AWS role, so
  there are no long-lived AWS keys in the repo, and `COCKROACHDB_URL` / `ALLOWED_ORIGIN` reach the task
  through Secrets Manager — the workflow passes the secret's ARN and never reads the values.
  `infra/aws/ecs-deploy.sh` is **not** this path: it bootstraps IAM roles, the bucket, and the service
  itself, and stays a local, occasional, human-run thing rather than something CI holds `iam:CreateRole`
  for. The image is built on an arm64 runner to match the service's ARM64 platform; an amd64 image dies
  with `exec format error` and the service silently rolls back.
- **Verifying a deploy:** `GET /health` returns `{version: "<short sha>"}` — match it against
  `git rev-parse --short HEAD`. A 200 alone proves nothing: during a rollout both revisions answer, so a
  status check passes instantly and tells you nothing.
- **Region:** everything runs in **us-west-2**. The rates quoted in §9 are us-east-1-ish reference numbers;
  re-confirm against us-west-2 when the bill starts mattering.
---
 
## 5. Data model (CockroachDB)
 
Scoped to one play (Merry Wives of Windsor) but structured so adding a second play is a data-import task, not a
schema change.
 
```
plays             (id, title, source_url, created_at)
characters        (id, play_id, name, description, is_synthetic, polly_voice_id)
                  -- polly_voice_id is per character, not an env var (migration 003); NULL falls back to
                  -- POLLY_DEFAULT_VOICE_ID
lines             (id, play_id, act, act_order, scene, scene_order, scene_description,
                   speech_number, line_number, text, stage_direction,
                   block_id, beat_number, source_lines, shares_first_source_line, is_verse,
                   embedding vector)
                  -- act is a label, not strictly a number: "1", "Induction", "Prologue" all valid (see section 6)
                  -- act_order/scene_order carry real document order so nothing has to sort roman numerals
                  -- ONE ROW IS ONE BEAT, not one line of verse — see the note below
line_speakers     (line_id, character_id)
                  -- many-to-many, NOT lines.character_id — see below
stage_directions  (id, play_id, act, act_order, scene, scene_order, sequence, after_line_number, text)
users             (id, name, created_at, username, pin_hash, failed_pin_attempts, locked_until)
auth_sessions     (id, user_id, token_hash, created_at, expires_at)
                  -- a logged-in browser session; session_history is a *rehearsal* session (migration 002)
roles_in_progress (id, user_id, play_id, character_id)
session_history   (id, user_id, play_id, act, scene_range, started_at, duration_seconds)
line_mastery      (id, user_id, line_id, confidence_score, last_practiced_at, mistake_count)
mistake_log       (id, user_id, line_id, session_id, what_was_said, embedding vector, created_at)
recordings        (id, session_id, s3_key, created_at)
```
 
Key implementation notes:
- **A row in `lines` is a *beat* — one thought — not a line of verse** (migration 004,
  `beats-and-blocks-plan.md`). The beat is what the coach scores and what `line_mastery` keys on. The unit of
  *display* and of a *single Polly render* is the **block**: one speech, cut wherever a stage direction falls
  inside it, grouped by `block_id`. Score per beat; render and display per block. Merry Wives went from 2,610
  verse-line rows to 1,705 beats in ~1,060 blocks, so any count derived from this table changed meaning as
  well as value.
- **`lines.line_number` is the scene-local *beat* sequence despite the name**, and
  `stage_directions.after_line_number` anchors to a beat. The name stayed because renaming it would churn
  every query and raw row type for no behavioural gain — worth knowing before reading it as a line of verse.
- **`source_lines` is required, not optional insurance.** Verse is memorized by its lineation and the joined
  `text` cannot reproduce it, so the original `<LINE>` texts are stored per beat; `shares_first_source_line`
  marks a beat whose boundary fell mid-line, and `is_verse` decides whether display keeps the lineation or
  wraps it (prose "lines" are only the source's fixed-width typesetting).
- **`lines` has no `character_id`.** Real play text has speeches with more than one `<SPEAKER>` — PAGE,
  SHALLOW and SLENDER jointly in act 1 — and a single FK would force picking one and silently drop the line
  for everyone else rehearsing that role. `line_speakers` is a many-to-many join instead.
- **`stage_directions` is its own table**, not in the original model: 193 blocking cues in Merry Wives, both
  between speeches and interleaved mid-speech. The importer already walks these nodes, so discarding them
  would lose entrance/staging cues for nothing.
- **Row ids are content-derived**, not `gen_random_uuid()` — see §6.
- `lines.embedding` and `mistake_log.embedding` use CockroachDB's vector column + distributed vector index.
  Both columns exist and are `VECTOR(1024)` — Titan Text Embeddings V2's width, not G1's 1536 (migration
  004 moved them). They are left NULL until embedding generation is built. The **index itself is still to be
  created** (`infra/cockroachdb/README.md`); it is v25.2+ and preview-gated
  (`SET CLUSTER SETTING feature.vector_index.enabled = true`), and isn't worth creating over an all-NULL
  column.
- Every session write (session_history + line_mastery updates + mistake_log inserts) happens in **one
  serializable transaction**, with retry-on-conflict handled explicitly (standard Cockroach pattern, don't skip it
  — this is a production-readiness signal, not boilerplate). Not built yet — the live session write path
  doesn't exist. The importer's transaction in `packages/play-importer/src/ingest.ts` is the working
  reference for the retry idiom, not a copy-paste source (`BE_PLAN.md` §3).
- Index `line_mastery` on `(user_id, line_id)` — done. `lines` is indexed on
  `(play_id, act_order, scene_order, line_number)` rather than `(play_id, act, scene)`, because document
  order is what every query sorts by, plus `(block_id, beat_number)` for "give me this block's beats in
  order," which serves both the audio endpoint and block display.
---
 
## 6. Source text — parsing plan
 
Source: Jon Bosak's Shakespeare XML (Moby Shakespeare text, public domain 1992; SGML/XML markup by Bosak,
1992-1998), e.g.
https://github.com/rufuspollock-okfn/shakespeare-material/blob/master/texts/moby/merry_wives_of_windsor_moby.xml
(raw: replace `/blob/master/` with `/raw/refs/heads/master/`)
 
Confirmed by direct inspection of three plays in the corpus (Merry Wives of Windsor, Romeo and Juliet, Taming of
the Shrew) — same publisher, same conventions throughout, so this generalizes across the corpus:
 
```
PLAY > TITLE, FM, PERSONAE (PERSONA, PGROUP > PERSONA + GRPDESCR), SCNDESCR, PLAYSUBT
PLAY > INDUCT?      (optional, sibling to ACT — contains its own SCENE(s), e.g. Taming of the Shrew)
PLAY > ACT > TITLE
ACT > PROLOGUE?     (optional, sibling to SCENE — contains SPEECH, e.g. Romeo and Juliet's Chorus)
ACT > SCENE > TITLE, STAGEDIR, SPEECH (SPEAKER, LINE+)
```
 
Maps directly onto the schema in section 5, with `act` treated as a flexible label (an act number, or
"Induction," or "Prologue") rather than assuming every play is strictly five acts of scenes.
 
**Parsing rules to build in, confirmed necessary across multiple plays (not edge cases to defer):**
1. **Stage directions nested inside a `LINE`** (e.g. `<LINE><STAGEDIR>Aside to GREGORY</STAGEDIR> Is the law...`)
   — extract/strip, don't import as spoken text.
2. **`PGROUP`** groups characters under a shared description — flatten each `PERSONA` inside a group into its
   own character row; grouping metadata isn't needed for the app.
3. **`INDUCT`** (induction) — a top-level sibling to `ACT`, containing its own `SCENE`s. Treat it as its own
   act-equivalent so frame-narrative content (e.g. Christopher Sly in Shrew) isn't silently dropped.
4. **`PROLOGUE`** — a sibling to `SCENE` within an `ACT`, containing a `SPEECH` with an often-empty
   `<SPEAKER></SPEAKER>` (typically the Chorus). Map blank speakers to a synthetic "Chorus"/"Narrator" character
   rather than failing the import or dropping the line.
5. **Group speaker `ALL`** — lines spoken in unison; map to a synthetic "ALL" character rather than treating as
   an error.
6. **Speakers with no matching `PERSONA`** — generic/numbered roles ("First Citizen," "Second Servant," "A
   Player," "Host") frequently never appear in the `PERSONAE` list at all. Auto-create a character record from
   the `SPEAKER` string when no exact match exists, rather than rejecting the line.
7. **Minor transcription inconsistencies in the source itself** (this is a 1990s public-domain transcription, not
   a live document — small errors are permanent, e.g. Shrew spells one character "HORTENSIO" everywhere but once
   as "HORTENSIA"). A light fuzzy-match of `SPEAKER` against the `PERSONAE` list catches most of these; don't
   expect a perfect 1:1 join on exact string match.
Settled: `packages/play-importer`, Node + `tsx` + `@xmldom/xmldom` (a DOM parser, no HTML-scraping risk),
fetching raw XML from the GitHub mirror above. Built generically enough to run against any play in the
corpus — which is what validated Merry Wives against a real spec, and is free groundwork for the "expand to
other plays" story later. All seven rules above proved necessary against the real text; two real bugs fell
out of running it (a bad `.map()`, and 44 silently-dropped mid-speech stage directions).

**What the importer grew after this section was written** — parsing a play is now the first half of the job,
not all of it:

1. **Beat and block segmentation** (`segment.ts`, `blocks.ts`). Parsing produces speeches and verse lines;
   the importer then cuts each speech into **blocks** (at any stage direction inside it) and each block into
   **beats** (one thought), because those, not `<LINE>`s, are the units the app scores, renders and displays.
   See `beats-and-blocks-plan.md` and §5.
2. **Content-derived ids** (`ids.ts`). `block_id` and line ids are UUIDv5 hashes over
   play/act/scene/speakers/**text**, not `randomUUID()`. Re-importing unchanged text therefore produces the
   *same* ids, so cached Polly audio and practice history survive a re-import; changed text produces new ids,
   so it re-renders and re-learns. Random ids meant every import silently invalidated both. The namespace
   constant must never change, or every id in every play changes with it.
3. **Verse-vs-prose detection.** The source records no marker, so the importer derives `is_verse` from the
   lineation itself.
4. **Voice assignment at import** (`voices.ts`), from a cited per-play list, so a re-import doesn't undo it
   the way a one-shot `UPDATE` would. The lists cover Merry Wives only; a play with no list warns loudly
   rather than silently voicing every woman as a man.
5. **Re-import is refused** when the play is already in the database, rather than quietly duplicating it.
   The consequence is that re-importing today means hand-writing the child-first DELETEs; a `--replace` flag
   doing them in the same transaction is the fix, best added before the next parser change
   (`OPEN_ITEMS.md` §4).

No fallback source is needed; the importer builds against this corpus directly.
 
---
 
## 7. Scope: what's in, what's cut, what's stretch
 
**In for MVP:**
- One play, full text, all characters and scenes
- Play → role → act/scene picker. Built as **one play page with two steps** (part, then the scenes that part
  is actually in) rather than three separate pages — the old `/play/:id/role` and `/play/:id/scenes` URLs
  redirect to it so bookmarks and the back stack don't 404
- Username + PIN accounts, so practice history belongs to somebody (see §4)
- Polly-voiced other characters, cached **per block** (one speech, one render — not per line, see §4)
- Record-and-compare rehearsal flow (tap to advance, not live streaming STT). The capture design has since
  moved on, though the code hasn't: the mic stays open across a whole **block** at natural pace, with beats
  as scoring boundaries rather than interaction boundaries, and alignment as a rolling fuzzy match against
  the block's expected beat texts. `OPEN_ITEMS.md` §1b has the reasoning; streaming partials are what let
  "Line?" feed the *next beat* instead of the whole speech
- Session logging + line mastery scores, written transactionally
- Agent reads memory before a session and gives a coaching note after
- Session recordings saved to S3, playable back
- Shakespearean visual identity (parchment/ink palette, serif display type) over a plain-language, accessible UI

*Built so far, of the above:* the picker flow end-to-end on real imported data, accounts, Polly playback off
the warmed block cache, and the visual identity. The wrap-up and Prompt Book screens render but still read
`frontend/src/data/mock/*`, and `/preview/blocks` is a local-only segmentation-review page to delete once the
rehearsal screen renders blocks for real. The rest of the list — capture, comparison, mastery writes,
coaching notes, recordings — is ahead. `docs/OPEN_ITEMS.md` is the running record of what's knowingly
unfinished and what's already settled about it.

**Explicitly cut (not this hackathon):**
- Other plays (architecture supports it, data doesn't need to yet)
- Live/streaming speech recognition with tight cue timing
- Multi-user/networked rehearsal
- Mobile native app
**Stretch, if time allows in week 3:**
- Vector-search-driven "you tend to struggle with X pattern" coaching insight (high value for the "Creativity"
  and "Agentic Memory Design" criteria — worth reaching for if week 1-2 go smoothly)
- Small admin/"coach's notes" view backed by MCP Server queries
---
 
## 8. Timeline (2-3 weeks, part-time, solo)
 
**Week 1 — foundation**
CockroachDB Serverless cluster provisioned via ccloud CLI (scripted, in-repo); schema created; Moby/Bosak text
parsed and imported for Merry Wives of Windsor; basic React picker (play → role → act/scene); Amplify + ECS/Fargate
deployed end-to-end on day one, even with nothing in it yet.

*How it actually went:* no provisioning script — the cluster already existed and was connected to directly
(§3). Schema, importer and import all landed here as planned. The end-to-end deploy did **not** happen on day
one; it came after the picker and Polly, and the first real run surfaced OIDC trust and deploy-permission
problems that a placeholder deploy would have caught earlier — the argument for "day one" was right even
though the order wasn't followed.
 
**Week 2 — the agent loop**
Polly voices wired up and cached; record-and-compare rehearsal flow; session writes (transactional); first
Bedrock call — agent reads history, writes back mastery scores and a coaching note. This is the core demo.
S3 recording save/playback.
 
**Week 3 (partial/buffer) — memory depth, resilience, polish**
Vector embeddings + nearest-neighbor mistake-pattern search; retry logic and graceful-degradation paths;
AWS Budget alert; Shakespearean visual pass; README, architecture diagram, demo video/script that explicitly
states the "skill model, not fact memory" framing for judges.
 
---
 
## 9. Cost notes (out of pocket)

Estimated for realistic usage — solo/single-user (Mom), a handful of rehearsal sessions a week, running
continuously so it's always available, not scale-to-zero. Prices are on-demand, us-east-1-ish reference rates,
confirm current numbers at build time (they shift). Two cost categories behave very differently here:

**Compute (ECS/Fargate + ALB) — fixed, always-on, this is where a 1-year commitment actually helps:**

| Item | Sizing | On-demand /mo | w/ 1-yr No-Upfront Compute Savings Plan |
|---|---|---|---|
| Fargate task | 0.25 vCPU / 0.5 GB (Hono is light; the real work is offloaded to Bedrock/Polly/Transcribe) | ~$9 | ~$7.20 (~20% off) |
| Application Load Balancer (auto-provisioned by Express Mode) | 1 ALB, 24/7, ~1 LCU avg | ~$20 | *not eligible* — Savings Plans only cover EC2/Fargate/Lambda compute, not ALB hours |
| ECR image storage + CloudWatch logs | 1 small image, low log volume | ~$1–2 | *not eligible* |
| **Compute subtotal** | | **~$30–31** | **~$28–29** |

The ALB is the uncomfortable finding here: at this traffic level it costs more than the compute it's
fronting, and a 1-year Fargate Savings Plan only nets ~$1.80/mo back — real money, but not the lever it
sounds like going in. It's effectively the fixed cost of "always-on HTTPS" (mic capture needs a secure
context, so TLS isn't optional). ECS Express Mode auto-provisions this ALB for you (that's the whole point —
no more hand-configuring target groups/listeners than App Runner required), but it's still billed as a
regular ALB, not folded into a bundled per-request price the way App Runner's was. Since App Runner itself
is now in maintenance mode (stopped taking new customers 2026-04-30), this is the real cost of its
recommended replacement, not an avoidable ECS-specific tax.

**AI services (Bedrock, Polly, Transcribe) — usage-based, no reservation/Savings Plan applies at all:**

At ~13 sessions/month, ~40 beats each (~520 beat-comparisons/month):

- **Transcribe**: $0.024/min, 15-second minimum per request → ~130 billed min/mo ≈ **$3–4/mo**. This is the
  dominant AI cost, driven by the per-request minimum, not audio length. Worth re-estimating when capture is
  actually built: the current design opens the mic once per **block**, not once per beat (`OPEN_ITEMS.md`
  §1b), and Merry Wives averages ~1.6 beats per block — so the billed *request* count, which is what the
  minimum multiplies, is meaningfully lower than the beat count above. Streaming rates also differ from
  batch; confirm which one the built path uses before trusting this line.
- **Bedrock Nova Micro** (per-beat comparison, ~520 calls/mo): well under **$0.05/mo**.
- **Bedrock** stronger model for session coaching notes (~13 calls/mo, low-frequency by design): well under
  **$0.05/mo**.
- **Polly** (**neural**, not generative — $16/1M chars against a 1M-char/mo free tier. Generative is the more
  expressive engine and was used first, but it is LLM-based and non-deterministic: it occasionally renders
  audio that keeps talking past the end of the text, in invented sentences. Three blocks of Merry Wives were
  cached that way. Neural returns byte-identical audio for identical input, so it cannot drift — see
  `POLLY_ENGINE`): cached per block, so synthesizing the *entire* Merry Wives of Windsor script once —
  confirmed via `deno task warm-polly-cache`'s dry run: ~109,400 characters — is ~$1.75 at full rate, and
  free within the tier. **One-time**, not recurring — every subsequent playback of the same block/voice pair
  costs nothing.
- **Titan embeddings** (mistake-log vector search, week-3 stretch): negligible, well under $0.01/mo.
- **AI services subtotal: ~$3–5/mo.**
- CockroachDB Serverless free tier: comfortably covers this scale, $0.
- S3: negligible at this scale.

**Realistic total: ~$33–36/mo on-demand, ~$31–34/mo with the 1-year Fargate Compute Savings Plan.** That's
above the current $25/mo AWS Budget alert threshold (`infra/aws/budget-alert.sh`) — bump it to ~$40/mo for
real headroom rather than raising it after the first overage email.

Biggest cost-control levers, in order of actual impact at this scale:
1. **Don't override Express Mode's default networking** (default VPC, public subnets) unless there's a
   specific reason to — its default already avoids the NAT Gateway trap; switching to private subnets later
   would add NAT's ~$33/mo base and roughly double the estimate above for no benefit at this scale/threat
   model.
2. Accept the ALB as the real fixed cost of always-on HTTPS; the 1-year Savings Plan is worth taking (it's
   free money) but don't expect it to move the total much — it only touches the Fargate line.
3. Per-**block** Polly caching (done — the whole script is warmed, so playback is free thereafter) and Nova
   Micro for the high-frequency comparison call (`BE_PLAN.md` §4) keep the *usage-based* side close to zero
   regardless of how much she actually rehearses. The one thing that can quietly undo this: warming and the
   live endpoint must compute byte-identical cache keys *and* identical block text, or a paid warm run
   misses on every request (`OPEN_ITEMS.md` §4). Relatedly, hitting `/polly/blocks/…` against a deployed
   environment is not a read-only check — a miss bills a synthesis and writes an S3 object. Use `/health`
   to smoke-test a deploy.
4. Set an AWS Budget alert at a realistic threshold as a safety net from day one — done, but the threshold
   needs revisiting now that ECS/ALB is the plan (see above).
---
 
## 10. Open items to verify with Claude Code before/while building
 
The running record of everything knowingly unfinished now lives in **`docs/OPEN_ITEMS.md`** — one place, with
what is undecided, why it matters, and what is already settled about it so the settled part isn't
re-litigated. The three items this section started with:

- [x] Exact CockroachDB vector column + index syntax — **column settled**: `VECTOR(1024)` to match Titan Text
      Embeddings V2 (1536 was G1's width), L2 distance because it is the only option CockroachDB offers, so
      Titan's default `normalize: true` is load-bearing rather than cosmetic — L2 and cosine only rank
      identically on unit-length vectors. Written up in `infra/cockroachdb/README.md` and `OPEN_ITEMS.md` §2.
      The **index migration is still open**, deliberately: not worth creating over an all-NULL column.
- [ ] Bedrock model IDs and current pricing at build time (verify against AWS Bedrock pricing page) — still
      open for the comparison and coaching models; the embedding model is chosen
      (`amazon.titan-embed-text-v2:0`, already in Bedrock, no new vendor).
- [x] Confirm MCP Server read-only scoping before wiring it into any in-app admin view — connected with
      READ+WRITE granted but used read-only in practice, with every write (`create_database`, `create_table`,
      `insert_rows`) confirmed first. Re-confirm before any admin view actually ships.
