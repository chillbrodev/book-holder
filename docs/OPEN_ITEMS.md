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

Related and unresolved: style guide §11 — `confidence_score` is continuous, so
a near-miss and a total blank currently read identically in the wrap-up.

Worth settling **before** Bedrock is wired, not after — it determines what the
comparison prompt is even asking for.

### 1b. Capture flow

Settled in design, unbuilt:

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

## 2. Embeddings and vectors

**Settled** (`beats-and-blocks-plan.md` §8), so the schema is right whether or
not the feature ships:

| | |
|---|---|
| model | Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) — already in Bedrock for coaching, no new vendor |
| dimension | **1024**, V2's default. Migration 004 moved both columns off `VECTOR(1536)`, which was Titan **G1**'s width. The column must match the model exactly or every insert fails. |
| distance | L2 — the only option CockroachDB offers (`infra/cockroachdb/README.md:46`) |
| normalization | leave Titan V2's `normalize` at its default `true` |
| unit | the beat, matching everything else |
| cost | ~27,000 tokens for all of Merry Wives — a fraction of a cent |

**Why normalization is load-bearing:** embedding models are generally trained
for *cosine* distance, which compares only the angle between two vectors.
CockroachDB offers only *L2*. The two rank identically **if** every vector is
unit-length, which is what normalizing does. Turning it off silently degrades
every nearest-neighbour result rather than erroring.

### Still open

- **Whether it ships at all.** `ORCHESTRATION_PLAN.md:60` has it as cut-first
  scope. Counterweight: `PROJECT_PLAN.md:45` lists "quality use of vector
  index" as a judging criterion, so it isn't purely optional.
- **`embedBeats.ts` isn't written.** Generation stays *out* of the importer on
  purpose — the importer must remain offline, deterministic, and re-runnable
  with no AWS credentials, which is what makes `--dry-run` review useful. Same
  reasoning as keeping Polly warming separate.
- **The vector index migration** (`infra/cockroachdb/README.md:31`) is still a
  TODO. Not worth creating over an all-NULL column.
- **Which column earns its keep.** `mistake_log.embedding` is the valuable one
  — nearest-neighbour over what she actually said turns forty scattered
  mistakes into "these six are the same mistake," which no SQL expresses. But
  it only becomes useful once she has history. `lines.embedding` is weaker
  (find beats resembling this one) but populatable at import, so it is what
  puts real content in the index on day one.

---

## 3. Rehearsal UI

None of these block anything.

- **`CharacterTile.tsx:33` says "N lines" while counting beats.** Merry Wives
  went 2,610 → 1,705, so the number changed meaning as well as value. Same for
  the wrap-up's `linesRun` and `listScenes`' `totalLines`. Copy pass.
- **Wrap-up and Prompt Book still read `data/mock/*`.** They compile and render,
  but the fabricated line ids diverge further from real data with every change.
- **Beat highlighting inside verse is unsolved.** Beats cross-cut verse lines —
  a boundary usually falls mid-line — so "highlight the active beat" and "keep
  the lineation" fight: you cannot box a beat without breaking the layout or
  highlighting partial lines. The "Line?" prompt sidesteps it by rendering the
  revealed beat below the block; a flubbed-beat marker won't be able to. Likely
  answer is an inline span with a background, which flows across line breaks
  naturally, but it needs beat text pre-split at verse-line boundaries.
- **Whether she can ask to hear her own lines.** `RehearsalPage.tsx:153` skips
  Polly entirely for `isUserLine`, which is right for a run-through and may be
  wrong for learning a speech cold.
- **Whether trivially short beats get rolled up in the Prompt Book.** 237 beats
  in Merry Wives are under 20 chars — all of them complete short *speeches*
  like `"Go."`. A mastery row for `"Ha!"` is noise in a "needs another look"
  list. Deliberately a surfacing decision, not a parser one.
- **`/preview/blocks`** is a local-only page driven by importer fixtures. Delete
  it once the rehearsal screen is the better place to judge segmentation.

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
