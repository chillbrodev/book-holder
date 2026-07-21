# The Book Holder
 
*A rehearsal partner with a memory, for actors without a scene partner on demand.*
 
Built for: CockroachDB × AWS Hackathon — "Build with Agentic Memory"
Deadline: August 18, 2026
Team: solo, part-time, ~2-3 weeks
Stack: React + Vite, CockroachDB (Serverless), AWS (Bedrock, Polly, Transcribe, S3, App Runner, Amplify)
Focus play: *The Merry Wives of Windsor* (MIT Shakespeare source), built to expand to other plays later.
 
---
 
## 1. The story (lead with this in the pitch)
 
An actress returning to her original career late in life, focused on Shakespeare. She needs a scene partner to
rehearse lines, but her real-life partner isn't available on her schedule and isn't always in the mood to read
Shakespeare on demand. The Book Holder is that partner: it voices every other character, listens to her lines,
remembers what she's mastered and what she hasn't, and tells her what to work on next time.
 
The name is real theater history — the "book holder" was the person backstage in Shakespeare's own company who
held the script and fed actors their forgotten lines. This app does the same job with an AI that has a memory.
 
This generalizes beyond one household: community theater actors, drama students, ESL learners practicing dialogue,
anyone who can't easily get a live rehearsal partner together on their schedule.
 
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
Rehearsal agent — Node/Express API on AWS App Runner
        |
   -----------------------------------------------
   |            |                |               |
CockroachDB   Bedrock        Polly + Transcribe   S3
(memory +     (coaching      (character voices,   (session
 vectors)      LLM)           listening)           recordings)
```
 
- **Frontend hosting:** AWS Amplify Hosting (connects to GitHub repo, auto-builds on push)
- **Backend hosting:** AWS App Runner (Dockerfile or repo-connected, autoscaling, HTTPS out of the box) — chosen
  over Lambda/API Gateway for a solo build to minimize new-service surface area to learn
- **Database:** CockroachDB Serverless (free tier comfortably covers single-user hackathon scale)
- **LLM:** Amazon Nova Micro/Lite for per-line comparison (cheap, high volume); a stronger model only for
  less-frequent session-summary/coaching-note generation
- **Voice:** Amazon Polly neural voices, one voice ID per character, cached per line after first synthesis
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
and imported for Merry Wives of Windsor; basic React picker (play → role → act/scene); Amplify + App Runner
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
 
- CockroachDB Serverless free tier: comfortably covers this scale.
- Bedrock: no free tier, but pure per-token pricing — Nova Micro/Lite is a small fraction of a cent per session
  for the comparison step; reserve any pricier model for the infrequent summary step.
- Polly: neural voices run per-character-synthesized; new AWS accounts get free-tier credit for the first six
  months, and per-line caching means you only pay to synthesize each line once, not once per rehearsal.
- Transcribe: pay-per-second of audio; single-user hackathon-scale usage is inexpensive.
- S3: negligible at this scale.
- Set an AWS Budget alert at a small threshold as a safety net from day one.
---
 
## 10. Open items to verify with Claude Code before/while building
 
- [ ] Exact CockroachDB vector column + index syntax (verify against current CockroachDB docs)
- [ ] Bedrock model IDs and current pricing at build time (verify against AWS Bedrock pricing page)
- [ ] Confirm MCP Server read-only scoping before wiring it into any in-app admin view
