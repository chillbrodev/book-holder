# Open items

*Started July 31 2026, after the beats-and-blocks work landed. The running
record of what is knowingly unfinished — not a backlog of every idea, but the
things a future reader would otherwise have to rediscover.*

Each item says what is undecided, why it matters, and what is already settled
about it, so nobody re-litigates the settled part.

---

## 1. Agentic coaching

The core of the product and the least built part of it. `BE_PLAN.md:60` —
Transcribe and Bedrock are both "not started." What exists today is the
segmentation that makes them possible: the **beat**, one thought, which is what
gets scored and what `line_mastery` keys on (`beats-and-blocks-plan.md` §2).

### 1a. The fuzzy-match threshold — the biggest open question in the product

Does a dropped "the" count as a miss? Shakespeare makes near-misses the norm,
so this will shape how the app *feels* more than any of the plumbing around it.
Too strict and every run is a wall of corrections; too loose and it never
catches the thing she actually keeps dropping.

**This item is now two questions, not one** (`coaching-plan.md` §3). Coaching
renders three bands — *solid* / *close* / *dry* — so there are **two cuts** to
place, and they are not the same kind of decision:

- **solid → close** is the original question above: how much slack does a working
  actor deserve on wording she has essentially got.
- **close → dry** is nearer to "did she have this at all". Capture already
  separates the extremes at the source — a skipped beat returns an empty `heard`,
  a fumbled one returns wrong words — so this cut is mostly about where a
  mangled-but-attempted beat stops counting as an attempt.

Settling the first does not settle the second. `SAID_IT_THRESHOLD` in
`features/sessions/score.ts` is one number today and its comment already says it
is a placeholder; three bands mean it becomes two.

Formerly related and now closed: style guide §11's "a near-miss and a full blank
read identically in the wrap-up" — the bands answer that. What is open is where
the cuts fall, not whether the distinction exists.

Worth settling **before** Bedrock is wired, not after — it determines what the
comparison prompt is even asking for.

**Now measurable rather than hypothetical.** Capture is built, and the dev-only
`CaptureDebugInfo` puts the live transcript under the speech. One finding already
constrains the answer: the ASR floor on Shakespeare is 2.76% WER, so the threshold
has to sit above that — but at least one error class is *deterministic* rather
than random ("the Hundredth Psalm" transcribes as "the 100 Psalm" every time), and
no threshold can both accept that and catch a real miss. That one has to be fixed
upstream, not tuned around (`capture-plan.md` §8).

### 1b. Capture flow

**Built and verified end to end, August 7 2026 — see `docs/capture-plan.md`**,
which records the mechanics (16 kHz PCM off an `AudioWorklet`, a server-held
WebSocket, one Transcribe stream per block) and every measurement behind them.
Against one real 8-beat block: 8 of 8 beats split correctly, **2.76% word error
rate**, partials ~1.4s behind the audio, and a deliberate 25-second silence
survived for 1.0s of keepalive cost.

The design below held up unchanged. Three things it didn't anticipate, all now
handled: a **skipped beat** needs a resync or the cursor stalls on the abandoned
thought and reports every later beat as wrong too; Transcribe **closes a stream
after 15 seconds of silence** — which a rehearsal exceeds legitimately every time
she stops to think or reads a revealed beat; and **a Transcribe segment is not a
beat** — the 8-beat block came back as 6 segments, one spanning three beats,
which is the empirical case for aligning by fuzzy match rather than splitting the
transcript.

What is *not* verified is a pass with a real voice — the audio above was Polly,
which has no room noise, hesitation, or half-restarted lines.

Settled in design, and now built:

- Mic stays open across a whole **block**; she delivers it at natural pace.
  Beats are scoring boundaries, not interaction boundaries — nothing stops and
  restarts at a beat edge, so short beats can't annoy her.
- Streaming Transcribe partials keep a beat cursor, which is what lets "Line?"
  feed the *next beat* rather than the whole speech.
- Alignment is a rolling fuzzy match against the block's expected beat texts,
  not a hard split of the transcript.

This replaces the earlier idea of aligning a transcript back onto *verse lines*
using word-level timestamps. Beat boundaries are real punctuation with a real
pause in delivery; a verse line boundary mid-sentence corresponds to nothing
audible at all.

### 1c. Monologue mode

Derived at read time from beat count (≥6 beats: 22 such blocks in Merry Wives).
Not a separate parse — a coaching mode:

- **Cap the notes.** A 16-beat speech could yield 16; a director gives two or
  three. Rank by severity, rest to the Prompt Book.
- **Mastery is the weakest beat, not the average** — averaging hides the one
  place she drops every time, which is the entire point of the feature.
- **Drill a section.** You cannot fix beat 7 by re-running 27 lines. Beat ±
  neighbours is the unit of a second pass.

### 1d. What gets compared

`beat.text` — the joined text, not `source_lines`. She speaks continuously, so
lineation isn't audible and has no place in a transcript diff; it is still what
she memorized, so it stays for display. Settled, recorded here because the
split is easy to get backwards.

---

### 1e. Session recordings — deliberately deferred

**Tabled as a nice-to-have, August 7 2026.** Not cost: measured, her whole part is
**1.8 MB** as Opus, and a year at 20 runs a month is 422 MB — under a penny a month
of S3. Deferred because it isn't the agentic loop, which is what this project is
being judged on.

Worth writing down what it *would* have been good for, because the reasoning nearly
went the other way:

- **Hearing how she sounds**, which is central to how actors actually work and
  isn't something the coaching text can substitute for.
- **Ground truth for the transcript.** When the app says a beat was missed, nothing
  today can tell whether she fumbled it or Transcribe mangled it. That ambiguity is
  exactly what blocks §1a, and it is how a custom-vocabulary fix would be
  validated. So a recording is evidence, not just a feature.

If it is picked up, three things need deciding and none of them are cost: it wants
its **own bucket** rather than the Polly cache (cache is purgeable and
regenerable; her voice is personal and unrecoverable), a **delete path**, which
does not exist anywhere today — `recordings` has no deletion mechanism and neither
IAM role holds `s3:DeleteObject` outside the cache bucket — and a **retention
window**, since "forever" is the wrong default for personal audio. The capture side
is the easy part: a second `MediaRecorder` tap off the `MediaStream` that already
exists (`capture-plan.md` §3).

### 1f. `GET /sessions/plan` has no caller

Built and verified — after a run where beat 3 was skipped and beat 5 fumbled, it
emphasised exactly those two, at confidence 0.00 and 0.21. **Nothing in the
frontend calls it.**

This is the *read memory → decide* half of `PROJECT_PLAN.md` §2's loop, and it is
the half that stays invisible. Coaching (`coaching-plan.md`) makes the **write**
half visible during a scene and the **show** half visible after it; neither of
them tells her, at the top of a scene, what to watch for based on last time.

Needs no Bedrock — the ordering already exists. It needs a screen.

*Carried forward from `docs/HANDOFF.md` §4c before that document was deleted.*

---

## 2. Embeddings and vectors

**Settled** (`beats-and-blocks-plan.md` §8), so the schema is right whether or
not the feature ships:

| | |
|---|---|
| model | Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) — already in Bedrock for coaching, no new vendor |
| dimension | **1024**, V2's default. Migration 004 moved both columns off `VECTOR(1536)`, which was Titan **G1**'s width. The column must match the model exactly or every insert fails. |
| distance | L2 (`<->`, `vector_l2_ops`). **Not because it is the only option — that was wrong.** Verified against the live v26.2.5 cluster: `<->` (L2), `<=>` (cosine) and `<#>` (inner product) all evaluate. L2 is *chosen*, and is safe because the vectors are normalized |
| normalization | leave Titan V2's `normalize` at its default `true` |
| unit | the beat, matching everything else |
| cost | ~27,000 tokens for all of Merry Wives — a fraction of a cent |

**Why normalization still matters:** embedding models are generally trained for
*cosine* distance, which compares only the angle between two vectors. L2 and
cosine rank identically **if** every vector is unit-length, which is what
normalizing does — so the stored vectors are correct under whichever operator a
query uses, and switching operators later cannot silently degrade results.
Measured on the first rows inserted: norm **1.000000** exactly.

An earlier version of this section called normalization load-bearing on the
grounds that L2 was CockroachDB's only distance. That was wrong (see the table),
and the correction is worth keeping visible: the reason to normalize is that it
makes the choice of operator *not matter*, not that there was no choice.

### Done — August 11 2026

- **`embedBeats.ts` is written and has run.** All **1,705** beats of Merry Wives
  embedded, **0 failures, 113 s** at concurrency 4, **$0.0006**. Generation
  stayed *out* of the importer as planned — it is a script alongside
  `warmPollyCache`, dry-run by default, resumable via `WHERE embedding IS NULL`,
  with `--limit` for proving the model and the cast before a full pass.
- **The vector index migration** shipped as `007_vector_index.sql`, over both
  `lines.embedding` and `mistake_log.embedding`. The second is created empty on
  purpose: it grows a row at a time with rehearsal rather than being built later
  over live data the coach is reading.
- **IAM needed a second grant.** Titan is the *opposite* ARN shape to Nova Micro
  — in-region, no inference profile, exactly one bare foundation-model ARN.
  Added to both `create-dev-user.sh` and `task-role-policy.sh`, because adding a
  model here is always two files.

### Still open

- **A query must pass the vector as a parameter, not a subquery.** `ORDER BY
  embedding <-> (SELECT …)` plans as a **FULL SCAN** — no error, no warning, and
  on 1,705 rows it still returns the right answer quickly, so it looks fine. The
  same query with `$1::VECTOR` plans as `• vector search`. Anything reading these
  indexes has to fetch the probe vector first and bind it; `EXPLAIN` is the only
  thing that tells the two apart.
- **Which column earns its keep.** `mistake_log.embedding` is still the valuable
  one — nearest-neighbour over what she actually said turns forty scattered
  mistakes into "these six are the same mistake," which no SQL expresses — and it
  is still empty, because it needs rehearsal history. `lines.embedding` is
  populated and already useful: seeded with Mistress Ford on her husband's lack
  of jealousy, its nearest neighbours are the jealousy plot, including two lines
  that share no significant word with the seed.

---

## 3. Rehearsal UI

None of these block anything.

- **`CharacterTile.tsx:33` says "N lines" while counting beats.** Merry Wives
  went 2,610 → 1,705, so the number changed meaning as well as value. Same for
  `listScenes`' `totalLines`. Copy pass. (The wrap-up's was fixed — it reads
  "Beats run" off a real `beats_run` column.)
- **The Prompt Book still reads `data/mock/*`.** It compiles and renders, but the
  fabricated line ids diverge further from real data with every change. The
  wrap-up no longer does: it reads `GET /sessions/summary`, and its fixtures were
  deleted rather than left to rot beside it (see the `/preview/blocks` postmortem
  below for why that matters).
- **Beat highlighting inside verse is unsolved.** Beats cross-cut verse lines —
  a boundary usually falls mid-line — so "highlight the active beat" and "keep
  the lineation" fight: you cannot box a beat without breaking the layout or
  highlighting partial lines. The "Line?" prompt sidesteps it by rendering the
  revealed beat below the block; a flubbed-beat marker won't be able to. Likely
  answer is an inline span with a background, which flows across line breaks
  naturally, but it needs beat text pre-split at verse-line boundaries.
- ~~**Whether she can ask to hear her own lines.**~~ — **yes, on request only.**
  The scene reading still skips her lines, because voicing them unasked rehearses
  the speech *for* her; "Read line aloud" appears only after she's called for the
  line, when reading it has already not been enough. Her blocks are in the warm
  cache like everyone else's (verified: `cached: true`), so it costs a signed-URL
  lookup, not a synthesis. The button had been rendering with no `onClick` since
  it was built. It mutes the mic while it plays — Polly out of the same laptop the
  mic is on is barge-in (`capture-plan.md` §8), self-inflicted rather than
  incidental.
- **Whether trivially short beats get rolled up in the Prompt Book.** 237 beats
  in Merry Wives are under 20 chars — all of them complete short *speeches*
  like `"Go."`. A mastery row for `"Ha!"` is noise in a "needs another look"
  list. Deliberately a surfacing decision, not a parser one.
- ~~**`/preview/blocks`**~~ — **deleted August 7 2026**, along with
  `DialogueBlockView` and `fixtureClient.ts`. The condition for deleting it was
  met (the rehearsal screen renders real blocks), but the reason it went *now* is
  worth recording, because it is a general warning about checked-in fixtures:

  Its two JSON fixtures had drifted from the importer in a way nothing detected.
  Not just the ids — those were pre-`ids.ts` v4 UUIDs, dead but harmless, since
  nothing read them but React keys. The real rot was **semantic**: the fixture
  predated the "a block is one speech, cut wherever a stage direction falls inside
  it" rule, so 10 of its speeches were split across two runs that still shared one
  `block_id`. `toDialogueItems` grouped *consecutive* beats by block id on the
  stated assumption that "block ids are unique per speech-run" — no longer true —
  and emitted **87 blocks keyed by 77 ids**. React reported duplicate keys and,
  as it warns it may, omitted children: switching from Merry Wives to Richard II
  updated the header, the stats and the stage directions but left the *speeches*
  showing the previous play. A reviewer judging segmentation on that page would
  have been reading the wrong play's text under the right play's title.

  The lesson is not "regenerate fixtures more often" — it is that a fixture
  checked in beside the code it feeds has no mechanism telling it the rules
  changed. The importer's own `rows.json` is the reference, and the database is
  now the reference for Merry Wives.

---

## 4. Importer and operations

- **No `--replace`.** The importer now refuses to import a play that already
  exists, which is the right default — but re-importing then means hand-writing
  eight DELETEs in child-first order, every time the parser changes. A
  `--replace` flag doing them inside the same transaction is the fix. Worth
  adding *before* the next parser change, not after.
- **The warm/live query pairing is load-bearing and unenforced.**
  `warmPollyCache`'s `string_agg(l.text, ' ' ORDER BY l.beat_number)` must stay
  byte-identical to `PollyService.getBlockAudio`'s. Verified once across all
  1,064 blocks; nothing stops them drifting later, and the symptom is a full
  paid warm run that then misses on every request. A test comparing the two
  would be cheap.
- **Voice lists cover Merry Wives only.** `voices.ts` warns loudly for a play
  with no list rather than silently voicing every woman as a man. Adding a play
  means adding its list.
- **StageAgent is client-rendered.** Character names are not in the server HTML
  — only the gender pills are — so any script to harvest genders would need to
  drive a browser. Its URLs also key on the numeric id and ignore the slug, so
  `/play/1437/twelfth-night/` silently serves *Taming of the Shrew*. If more
  plays are ever needed, look for a structured dataset first.
- **Jointly-spoken blocks are warmed once per speaker** (3 in Merry Wives).
  Playback requests `speakerIds[0]`, so a few cached objects are never
  requested. Costs pennies; noted so it isn't mistaken for a bug.

---

## 5. Content and corpus

- **The over-ceiling tail is accepted, not fixed.** 1.75% of beats exceed 200
  chars because the sentence has no internal `;`/`:` — worst is Gaunt's "This
  royal throne of kings" at 895 chars across 21 verse lines. Comma-splitting
  would fix 13 monsters (0.04%) while applying comma logic to the other 99.96%,
  where commas aren't rhetorical turns. Revisit only if someone rehearses a
  history play; verse plays run 3–4% versus prose comedies' 0.3%.
- **Henry V III.iv is entirely in French** (Katharine's English lesson). It
  segments correctly, but Polly with an English voice will mangle it, and the
  Moby transcription has stripped the accents (`tu as ete`). Irrelevant while
  Merry Wives is the focus play; a real trap if the play list widens.
- **Split verse lines shared between two speakers** — cue pickup. Moby records
  them as separate `<LINE>`s in separate `<SPEECH>`es with no marker, so they
  cannot be reliably detected. Out of scope.
- **The three `&c.` song fragments** are passed through as-is. Polly will read
  them literally.

---

## 6. Recently closed, so nobody reopens them

- ~~Whether display and coaching need the same unit~~ — they don't, and they
  never contend: Polly voices only other characters' lines, the mic captures
  only hers. Display is the sole shared concern and the block wins for both.
- ~~Whether re-importing invalidates the Polly cache~~ — no longer, since ids
  are content-derived (`ids.ts`). Retuning the beat rules leaves every block id
  intact; only the re-cut beats' mastery resets.
- ~~Whether the voice assignment survives a re-import~~ — yes, it's assigned at
  import from a cited list rather than a one-shot UPDATE.
