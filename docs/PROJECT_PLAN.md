# The Book Holder
 
*A rehearsal partner with a memory, for actors without a scene partner on demand.*
 
Built for: CockroachDB × AWS Hackathon — "Build with Agentic Memory"
Deadline: August 18, 2026
Team: solo, part-time, ~2-3 weeks
Stack: React + Vite, Deno + Hono (`api`), CockroachDB (Serverless), AWS (Bedrock, Polly, Transcribe, S3, ECS/Fargate, Amplify)
Focus play: *The Merry Wives of Windsor* (MIT Shakespeare source), built to expand to other plays later.
 
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
 
- Before a session: agent reads her per-line mastery scores for the chosen scene and decides what to emphasize.
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
| Technical Implementation | Quality use of vector index, MCP Server, ccloud CLI | Vector index used for real nearest-neighbor mistake-pattern search; MCP Server used read-only during dev (and optionally a "coach's notes" admin view); ccloud CLI scripted into repo setup, not manual clicks |
| Real-World Impact | Meaningful use case, not just a demo | Lead pitch with the actress's story; generalize to community theater / drama students / ESL practice |
| Production Readiness | Security, observability, resilience, cost control | No keys in client code; retry logic around Cockroach serializable transactions; graceful degradation if Bedrock/Polly are slow or down; AWS Budget alert |
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
- **LLM:** Amazon Nova Micro/Lite for per-line comparison (cheap, high volume); a stronger model only for
  less-frequent session-summary/coaching-note generation
- **Voice:** Amazon Polly generative voices, one voice ID per character (`characters.polly_voice_id`, not an
  env var — see `BE_PLAN.md` §0), cached per line after first synthesis
- **Listening:** Amazon Transcribe, processing her recorded line after she finishes speaking (not live streaming —
  cut for time/risk; live STT is a stretch goal, not MVP)
- **Storage:** S3 for session recordings (her voice, or her + AI voices), IN the MVP per project scope
---
 
## 5. Data model (CockroachDB)
 
Scoped to one play (Merry Wives of Windsor) but structured so adding a second play is a data-import task, not a
schema change.
 
```
plays            (id, title, source_url)
characters       (id, play_id, name)
lines            (id, play_id, act, scene, line_number, character_id, text, embedding vector)
                 -- act is a label, not strictly a number: "1", "Induction", "Prologue" all valid (see section 6)
users            (id, name, ...)
roles_in_progress (id, user_id, play_id, character_id)
session_history  (id, user_id, play_id, act, scene_range, started_at, duration)
line_mastery     (id, user_id, line_id, confidence_score, last_practiced_at, mistake_count)
mistake_log      (id, user_id, line_id, session_id, what_was_said, embedding vector, created_at)
recordings       (id, session_id, s3_key, created_at)
```
 
Key implementation notes:
- `lines.embedding` and `mistake_log.embedding` use CockroachDB's vector column + distributed vector index.
- Every session write (session_history + line_mastery updates + mistake_log inserts) happens in **one
  serializable transaction**, with retry-on-conflict handled explicitly (standard Cockroach pattern, don't skip it
  — this is a production-readiness signal, not boilerplate).
- Index `line_mastery` on `(user_id, line_id)` and `lines` on `(play_id, act, scene)` for the query patterns the
  app actually uses.
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
Parse with any standard XML library (lxml/ElementTree in Python, or a DOM parser in Node) — no HTML-scraping risk
here. No fallback source needed; build the importer against this corpus directly, generically enough to run
against any play in it (useful now for validating Merry Wives against a real spec, and free groundwork for the
"expand to other plays" story later).
 
---
 
## 7. Scope: what's in, what's cut, what's stretch
 
**In for MVP:**
- One play, full text, all characters and scenes
- Play → role → act/scene picker
- Polly-voiced other characters, cached per line
- Record-and-compare rehearsal flow (tap to advance, not live streaming STT)
- Session logging + line mastery scores, written transactionally
- Agent reads memory before a session and gives a coaching note after
- Session recordings saved to S3, playable back
- Shakespearean visual identity (parchment/ink palette, serif display type) over a plain-language, accessible UI
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
CockroachDB Serverless cluster provisioned via ccloud CLI (scripted, in-repo); schema created; MIT text parsed
and imported for Merry Wives of Windsor; basic React picker (play → role → act/scene); Amplify + ECS/Fargate
deployed end-to-end on day one, even with nothing in it yet.
 
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

At ~13 sessions/month, ~40 lines each (~520 line-transcriptions/month):

- **Transcribe**: $0.024/min, 15-second minimum per request → ~130 billed min/mo ≈ **$3–4/mo**. This is the
  dominant AI cost, driven by the per-request minimum, not audio length.
- **Bedrock Nova Micro** (per-line comparison, ~520 calls/mo): well under **$0.05/mo**.
- **Bedrock** stronger model for session coaching notes (~13 calls/mo, low-frequency by design): well under
  **$0.05/mo**.
- **Polly** (**generative**, not neural — see `BE_PLAN.md` §0/§4 — $30/1M chars vs neural's $16/1M, and only a
  100K-char/mo free tier vs neural's 1M): cached per line, so synthesizing the *entire* Merry Wives of
  Windsor script once — confirmed via `deno task warm-polly-cache`'s dry run: ~107,900 characters — is
  ~$3.24 at full rate, ~$0.24 net of the smaller generative free tier (first 12 months, first use that
  month). **One-time**, not recurring — every subsequent playback of the same line/voice pair costs nothing.
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
3. Per-line Polly caching and Nova Micro for the high-frequency comparison call (both already in `BE_PLAN.md`
   §4) keep the *usage-based* side close to zero regardless of how much she actually rehearses.
4. Set an AWS Budget alert at a realistic threshold as a safety net from day one — done, but the threshold
   needs revisiting now that ECS/ALB is the plan (see above).
---
 
## 10. Open items to verify with Claude Code before/while building
 
- [ ] Exact CockroachDB vector column + index syntax (verify against current CockroachDB docs)
- [ ] Bedrock model IDs and current pricing at build time (verify against AWS Bedrock pricing page)
- [ ] Confirm MCP Server read-only scoping before wiring it into any in-app admin view
