# Beats and blocks — how the play text is segmented

*Written July 30 2026. **Supersedes `line-sequencing-plan.md`**, which is deleted.
That doc correctly diagnosed the audio fault but proposed the wrong fix: merging
speeches at read time and handing Polly a client-supplied `lineIds[]` array.
The design below moves the segmentation into the importer instead, which makes
most of that API surface unnecessary.*

*Numbers below are measured against the real parsed output of two plays —
`the-merry-wives-of-windsor` (prose-heavy) and `alls-well-that-ends-well`
(verse-heavy). Validation across all 37 plays is step 3 of the build order.*

---

## 1. The problem, both halves

**The audio half.** `lines` holds one row per line of verse/prose, so Polly is
asked to synthesize each typographic line separately. A row ending mid-sentence
("…I must turn away some of my") gets *sentence-final* falling intonation and a
trailing pause. The jerkiness is baked into the mp3 bytes; it is not a playback
timing problem. Measured on one 2-line speech:

| | bytes |
|---|---|
| old fragment 1 — "Truly, mine host, I must turn away some of my" | 25,100 |
| old fragment 2 — "followers." | 6,668 |
| **sum if stitched** | **31,768** |
| single render of the whole sentence | 25,532 |

Stitching yields **24% more audio than the correct render of the same words**,
and the surplus is dead air. Concatenation cannot remove it.

**The display half.** The UI renders each row as its own block, repeating the
speaker header mid-speech:

```
FALSTAFF   Bardolph, follow him. A tapster is a good trade:
FALSTAFF   an old cloak makes a new jerkin; a withered
FALSTAFF   serving-man a fresh tapster. Go; adieu.
```

**And the half that makes it hard.** Playback and display want the speech
*whole*. Coaching wants it *divided* — small enough that a note is actionable,
large enough that the note is about a thought rather than a word. One unit
cannot serve both.

## 2. The resolution: three units, one owner each

The dilemma dissolves because playback and capture never touch the same rows.
`RehearsalPage.tsx:153` fetches Polly audio only when `!entry.isUserLine` — cue
lines are synthesized and never captured; her own lines are captured and never
synthesized. Display is the only shared concern, and there the block wins for
both.

| unit | definition | owns |
|---|---|---|
| **block** | one speech, split wherever a mid-speech stage direction falls | speaker header, the visual paragraph, one Polly render |
| **beat** | one thought — roughly a sentence, clause-split when long. **The row in `lines`.** | capture, scoring, `line_mastery`, `mistake_log`, flagging, the "Line?" prompt |
| **verse line** | the original `<LINE>` element | lineation on screen, meter-aware coaching later |

"Beat" is borrowed from theatre, where it means a change of intention rather
than a sentence. The register is right and the term is free — style guide §3
doesn't use it.

**Blocks are materialized by the importer, not derived at read time.** This is
the change that collapses the old plan's API surface. `line-sequencing-plan.md`
§3c argued the client must send an ordered `lineIds[]` array because "only the
caller — which performed the interleave — knows where a stage direction split a
speech." True only if the split is reconstructed at runtime. The importer knows
where it falls, so it persists a `block_id` and nobody reconstructs anything.

## 3. Segmentation rules

Applied per speech, in order. Nothing ever merges across a speech boundary or
across a mid-speech stage direction.

**3a. Join the verse lines of a speech into one text.**
Single space, except: when a line ends in letter + `-` **and** the next line
starts lowercase, join with no space — the word was broken across the line.

| joined | why |
|---|---|
| `"…I will make a Star-"` + `"chamber matter of it"` | → `Star-chamber` |
| `"…a prief of it in my note-"` + `"book; and we will…"` | → `note-book` |
| `"…scaped love-letters in the holiday-"` + `"time of my beauty"` | → `holiday-time` |
| `"…to whose falls-"` + `"Heaven prosper the right!"` | left alone — next line is capitalized |

Four candidates in Merry Wives; the rule gets all four right. `--` (56
occurrences, interruptions) is never joined.

**3b. Split into sentences** on `.` `?` `!` plus any trailing quotes or
brackets. No abbreviation defense needed — the corpus has no `Mr.` / `Mrs.` /
`St.` / `Dr.`. `&c.` appears 3 times, all inside songs; accepted as-is.

**3c. Absorb interjections.** A fragment under 40 chars that ends in `!` merges
into the following sentence. A short fragment ending in `.` or `?` does **not**
— it is a complete thought and a coach must be able to name it separately.

| merged (ends `!`) | kept apart (ends `.` / `?`) |
|---|---|
| `"Ha! o' my life, if I were young again…"` | `"Well, let us see honest Master Page."` \| `"Is Falstaff there?"` |
| `"Tut, a pin! this shall be answered."` | `"Peace, I pray you."` \| `"Now let us understand."` |
| `"Slice, I say! pauca, pauca: slice!"` | `"Mistress Anne Page?"` \| `"She has brown hair…"` |

The naive version of this rule — merge any short fragment forward — was tried
and rejected: it fired 340 times in Merry Wives and most of those glued two
distinct thoughts together, which is exactly what makes a coaching note
useless. The `!` restriction drops it to 154 honest merges.

**3d. Clause-split anything over 200 chars** at `;` and `:`, accumulating
clauses greedily rather than splitting at every one. Shakespeare's colons and
semicolons are rhetorical turns, so these land where an actor breathes:

```
| Briefly, I do mean to make love to Ford's wife:
| I spy entertainment in her;
| she discourses, she carves, she gives the leer of invitation:
| I can construe the action of her familiar style;
| and the hardest voice of her behavior, to be Englished rightly, is, 'I am Sir John Falstaff's.'
```

**200 is a target, not a guarantee.** 0.5–0.7% of beats exceed it because the
sentence has no internal `;` or `:` — one unbroken thought, correctly left
whole. We do not fall back to splitting on commas to hit a number. 150 was
tested and rejected: the extra splits don't fall on turns, they fall wherever
150 chars ran out.

**3e. Stage directions break blocks.** A mid-speech `<STAGEDIR>` ends the
current block and starts a new one, so the direction stays in position. In
Merry Wives, 44 of these exist and **none land mid-sentence**, so no text is
mangled — but the rule is required for the rest of the corpus. Line-level
inline directions (22 in Merry Wives) all sit on the first line of their
speech; they attach to the block, not to a beat.

## 4. What the corpus says

| | Merry Wives | All's Well |
|---|---|---|
| verse-ish (continuation lines starting capitalized) | 27% | 63% |
| verse-line rows (today) | 2,610 | — |
| speeches | 1,018 | 935 |
| raw sentences | 1,765 | — |
| **beats** | **1,701** | **1,488** |
| beat chars p50 / p90 / max | 47 / 143 / 246 | 63 / 166 / 383 |
| beat words p50 / p90 / max | 9 / 27 / 44 | — |
| beats over 200 chars | 8 (0.5%) | 11 (0.7%) |

**Long speeches do not produce more beats per line** — they produce longer
thoughts, and Shakespeare punctuates them:

| play | longest blocks (verse lines → beats) |
|---|---|
| Merry Wives | 37L→11b, 30L→16b, 28L→11b, 27L→16b |
| All's Well | 31L→11b, 28L→11b, 27L→9b, 25L→8b |

Helena's 27-line speech (All's Well I.iii) splits into 9 beats, each one a
piece an actor would work as a piece:

```
1| Then, I confess, Here on my knee, before high heaven and you, That before you,
   and next unto high heaven, I love your son.
2| My friends were poor, but honest; so's my love: Be not offended; for it hurts
   not him That he is loved of me: I follow him not By any token of presumptuous suit;
3| Nor would I have him till I do deserve him; Yet never know how that desert should be.
…
```

Note the mid-sentence capitals in beat 1 — that is verse lineation bleeding
through the joined text. It is why §5 stores `source_lines`.

### 4a. Whole-corpus run (all 37 plays)

Implemented rules, run over every Moby play. **No parse failures.**

| | |
|---|---|
| verse lines → beats | **107,630 → 56,069** in **32,322 blocks** |
| beats over the 200-char ceiling | 983 (**1.75%**) — higher in the verse-heavy histories than in prose comedies |
| longest beat | **895 chars** — Gaunt's "This royal throne of kings" (Richard II), 21 verse lines of anaphora with one internal colon |
| beats over 400 chars | 13 across the 20 plays sampled for it (**0.04%**) |
| repeated adjacent verse lines in one block | 3, all song refrains — see §5 |
| abbreviation false-splits | **none.** The frequent "short capitalized word + period" endings are all genuine sentence-final words (`Rome.`, `York.`, `Amen.`, `John.`) |

### 4b. Tag audit — content the parser was silently dropping

Aggregate beat counts cannot catch XML the parser never looks at, so every
element name in all 37 files was censused against what `parseXml.ts` consumes.
Three real defects, all now fixed:

| tag | scope | was | now |
|---|---|---|---|
| `EPILOGUE` | 6 plays | **dropped entirely** — Prospero's "Now my charms are all o'erthrown", Rosalind's epilogue, the Henry V chorus | parsed as a pseudo-scene after the act's scenes, mirroring `PROLOGUE`; `<SUBTITLE>` becomes its scene description |
| `SUBHEAD` | 14 uses in 10 plays, incl. **Merry Wives V.v** | **dropped** — `SONG.` vanished and the song's verse merged into the surrounding speech, so a block ran straight from spoken verse into song | treated like a stage direction: keeps its position *and* breaks the block |
| bracketed `<SPEAKER>` | 1 (`[PROSPERO]`) | would have created a second PROSPERO once the epilogue parsed, detaching it from the part | brackets stripped in `resolveSpeakerKey` |

Confirmed safe to keep ignoring: `FM`/`P` (front matter), `GRPDESCR` (already
deliberate), `PLAYSUBT`, `SCNDESCR` (a play-level setting line, not per-scene).

This is the check worth repeating whenever the source corpus changes — the beat
statistics all looked healthy while three plays' worth of content was missing.

**The over-ceiling tail is accepted, not fixed.** A last-resort comma split
would turn those 13 monsters into 42 units, but commas are not rhetorical turns
in the other 99.96% of beats, and the rule would be applied to all of them. They
are flagged `!` in `beats.txt` and can be revisited if anyone actually rehearses
Gaunt.

## 5. Schema (migration 004)

`lines` becomes one row per **beat**:

| column | change |
|---|---|
| `line_number` | now the beat's scene-local sequence, not a verse line number |
| `block_id UUID NOT NULL` | new — the speech-block this beat belongs to |
| `beat_number INT NOT NULL` | new — position within the block |
| `source_lines TEXT[] NOT NULL` | new — the original `<LINE>` texts this beat spans |
| `shares_first_source_line BOOL NOT NULL` | new — the beat boundary fell mid-line, so `source_lines[0]` repeats the previous beat's last entry. Block-level verse display drops it. |
| `is_verse BOOL NOT NULL` | new — block-level. Verse keeps its lineation on screen; prose is wrapped to the container, since its "lines" are only Moby's fixed-width typesetting. Moby records no marker, so it is derived from the lineation itself (`blocks.ts`): 80%+ of a block's continuation lines starting capitalized. Validated against ground truth — all-verse Richard II scores 99%, prose-heavy Merry Wives 12%. One-line blocks carry nothing to read and inherit their **scene's** dominant mode, since Shakespeare switches form at scene and character boundaries, not line by line. |
| `text` | unchanged in shape: the joined beat text, for Polly and for comparison |

**Why `shares_first_source_line` is stored rather than inferred:** a beat
boundary usually falls mid-line, so that line legitimately appears in two
adjacent beats. De-duplicating by *comparing the text* looks equivalent and
isn't — a song refrain repeats an identical line inside one block, 3 times
across the corpus (e.g. All's Well, "With that she sighed as she stood,"), and
string equality silently swallows the repeat. The flag records what the importer
already knows by line index.

`source_lines` is **required, not optional insurance**. Display must render
verse by the pentameter line — that is how the part is memorized — and the
joined `text` cannot reproduce it. Merry Wives hid this from us by being mostly
prose. Retrofitting it means another full re-import.

`stage_directions.after_line_number` now refers to a beat sequence. Semantics
unchanged, values differ.

`lines.embedding` and `mistake_log.embedding` change from `VECTOR(1536)` to
`VECTOR(1024)` — see §8.

A separate `blocks` table was considered and rejected: `block_id` as a column
carries the identity the cache key needs without a join or a migration of
`line_speakers`.

**Knock-on:** `characters.lineCount` becomes a beat count (2,610 → 1,701 for
Merry Wives), which changes what the role picker means by "a 12-line role."
Copy needs a pass.

## 6. API surface

| endpoint | change |
|---|---|
| `GET /polly/blocks/:blockId/audio` | replaces `GET /polly/lines/:lineId/audio`. Server concatenates that block's beats in order — no client-supplied array, no re-derivation. |
| cache key | `{play}/{character}/{blockId}__{voiceId}.mp3` |
| `getSceneDialogue` | returns beats carrying `blockId`; the frontend groups by it. **No `mergeAdjacentSpeeches`** — the adjacency logic in the old plan is gone. |
| `warmPollyCache.ts` | iterates blocks. Still queries the DB directly; no need to route through `PlaysService`, because the grouping is persisted rather than computed. |

## 7. Per-angle design

**Display.** One header, one paragraph per block. Verse rendered from
`source_lines`; prose wrapped normally. Beat boundaries are **invisible during
a run** and only carry state afterward.

**Playback.** One Polly render per block, cue lines only. Whether she can ask
to hear her *own* line read is unresolved — today `RehearsalPage.tsx:153` skips
synthesis for `isUserLine` entirely.

**Capture and coaching.** The mic stays open across the whole block; she
delivers it at natural pace. Nothing stops and restarts at a beat boundary, so
short beats cannot annoy her — they are scoring boundaries, not interaction
boundaries. Streaming Transcribe partials keep a beat cursor so a "Line?"
request feeds **the next beat** — not the whole speech (gives it away), not a
half verse line (useless mid-thought).

This replaces `line-sequencing-plan.md` §5's proposal to align a transcript
back onto verse lines using word-level timestamps. Beat boundaries are real
punctuation with a real pause in her delivery, so they are far easier to align
on than typographic wraps.

The friction budget, explicitly:

| never interrupts | deliberately does |
|---|---|
| mic open across the block | "Line?" feeds the next beat |
| no beat boundaries drawn during a run | a small number of notes after the block, director-style |
| cue lines play as one block | wrap-up drill list, beat-level |

**Monologue mode.** Not a separate parse — a coaching mode, derived at read
time from beat count (≥6 beats: 46 such blocks in Merry Wives, 87 in All's
Well). What differs:

- **Cap the notes.** 9 beats could yield 9 notes; a director gives two or
  three. Rank by severity, surface the top few, rest to the Prompt Book.
- **Mastery is the weakest beat, not the average** — averaging across 9 beats
  hides the one place she drops every time.
- **Drill a section.** You cannot fix beat 7 by re-running 27 lines. Beat ±
  neighbors is the unit of a second pass; blocks cannot express that.

## 8. Embeddings

An embedding is a fixed-length list of numbers standing in for the *meaning* of
a piece of text: similar meaning lands nearby, regardless of shared wording.
Nearest-neighbour search over them is what turns a flat list of forty mistakes
into "these six are the same mistake."

Two columns, not equally valuable:

- **`mistake_log.embedding`** — the one that earns its keep. Embedding what she
  actually said lets the coach find *patterns* across a rehearsal history, which
  is not expressible in SQL. Only becomes useful once she has history.
- **`lines.embedding`** — weaker (find beats resembling this one, to build a
  drill set) but populatable at import time, so the vector index has real
  content from day one. `PROJECT_PLAN.md:45` scores "quality use of vector
  index".

**Decisions:**

| | |
|---|---|
| model | Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) — already in Bedrock for coaching, so no new vendor or credentials |
| dimension | **1024** (V2's default; 512 and 256 also offered). The old `VECTOR(1536)` matched **Titan G1**, the previous model — not what we want. |
| distance | L2, the only option CockroachDB offers (`infra/cockroachdb/README.md:46`) |
| normalization | leave Titan V2's `normalize` at its default `true` |

The column width must match the model's output exactly or every insert fails,
which is why the dimension is settled here rather than at §12 step 4 — migration
004 is the free moment to change it.

**Why normalization is load-bearing:** embedding models are generally trained
for *cosine* distance, which compares only the angle between two vectors and
ignores their length. CockroachDB offers only *L2* (straight-line) distance. The
two rank results identically **if** every vector is scaled to the same length —
which is what normalizing does. Titan V2 does it by default. Turning it off
silently degrades every nearest-neighbour result rather than erroring, so don't.

Unit: the **beat**, matching everything else.

Cost: ~27,000 tokens to embed all of Merry Wives — a fraction of a cent.
Consistent with `PROJECT_PLAN.md:248`. Embeddings are not a spending decision
the way Polly is.

Generation stays **out of the importer**, in a separate `embedBeats.ts` script.
The importer must remain offline, deterministic, and re-runnable without AWS
credentials — the property that makes `--dry-run` review useful. Same reasoning
as keeping Polly warming separate.

## 9. Migration

No practice history exists, so the DB can change freely — but this is a
one-shot. Once she has real rehearsal history, re-importing gets expensive.

1. Migration 004 (§5).
2. Re-import — mints new UUIDs, orphaning any `line_mastery` / `mistake_log`
   rows and making every cached mp3 unreachable.
3. Wipe the S3 cache prefix. (Includes one known orphan from earlier endpoint
   verification: `…/falstaff/{lineId}__Brian__speech2.mp3`.)
4. Re-warm — ~108,900 chars for Merry Wives, ~**$3.27** at generative pricing.
   Unchanged by the unit choice: same words either way.

**Deferred until the parser and visuals are demonstrated.** Deferring costs
nothing — the re-import invalidates the existing cache regardless of when we
warm, so warming earlier would be pure waste. The browser's built-in
`SpeechSynthesis` is a free stand-in for hearing whether a block plays as one
natural unit; bad voices, but it proves the sequencing.

## 10. Open questions

Moved to `OPEN_ITEMS.md`, which is the running record across the whole project
rather than just this change. The ones that came out of this work: the
fuzzy-match threshold (§1a there, and the biggest of them), whether trivially
short beats are rolled up in the Prompt Book, how a flubbed beat is marked
inside verse lineation, whether she can hear her own lines, and whether
embeddings ship at all.

## 11. Explicitly out of scope

Split verse lines shared between two speakers (cue pickup) — Moby XML records
them as separate `<LINE>`s in separate `<SPEECH>`es with no marker, so they
cannot be reliably detected. The three `&c.` song fragments.

## 12. Build order

1. ~~Rewrite `packages/play-importer/src/buildRows.ts`~~ **done** — beat rows
   with `block_id`, `beat_number`, `source_lines`,
   `shares_first_source_line`; rules live in `src/segment.ts`.
2. ~~`beats.txt` review artifact~~ **done** — blocks as they would display,
   verse above beats, over-ceiling beats marked `!`, anomaly summary at the top.
3. ~~Run across all 37 plays~~ **done** — see §4a.
4. ~~Migration 004 + re-import~~ **done** — 1,705 beats in 1,060 blocks live in
   CockroachDB. `insertLines` had to move from `unnest` to multi-row `VALUES`:
   CockroachDB doesn't implement multi-dimensional arrays (crdb#32552), so an
   array-valued column can't ride the bulk-unnest pattern.
5. ~~API + frontend render blocks~~ **done** — `getSceneDialogue` returns
   `blockId`/`sourceLines`/`isVerse`, the client groups consecutive beats, and
   "Line?" hands over one beat at a time instead of the whole speech.
6. Polly re-warm — the block endpoint exists, but the S3 cache is empty (new
   UUIDs), so every cue block currently synthesizes on first play.
7. `embedBeats.ts` + vector index — after that, and cut-first if time is short.
