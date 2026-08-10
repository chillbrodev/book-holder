# Coaching: telling her how it went, while it is still going

*Started August 10 2026. Supersedes the "feedback only at the wrap-up" decision in
`design-system/book-holder-style-guide.md` §9, which is updated to match.*

This covers the third stage of `PROJECT_PLAN.md` §2's loop — **decide** — and the
part of **show** that happens during a scene rather than after it. Capture
(`capture-plan.md`) delivers what she said. Sessions (`features/sessions`) record
it. This doc is about the judgement in between, and where that judgement surfaces.

---

## 1. The decision, in one table

| Question | Answer | Why |
|---|---|---|
| When is a beat scored? | When the **block** it belongs to finishes | The capture socket already emits `complete` with the block's (expected, heard) pairs — the scoring inputs are in hand, server-side, at that moment |
| What is one Bedrock call? | One **block** | Matches the Polly render and display unit; gives the model the whole speech as context instead of a fragment |
| What does it return? | Per-**beat** results, plus one note for the block | The beat stays the scored unit. Only the *call* is block-shaped |
| Where does it appear? | Under the block, in a reserved slot | See §4 |
| What is shown? | *solid* / *close* / *dry* | A percentage is a grade, and the style guide's voice is backstage crew, not a teacher (§2 of the guide) |
| What is stored? | `confidence_score`, continuous, as today | The band is derived at read time, not persisted — see §6 |
| Who gets it? | Everyone rehearsing; only signed-in users get it *persisted* | The capture socket has no auth gate on purpose |

---

## 2. Why the block, and not the beat

A beat is one thought, and out of context that is exactly the problem. Judging
"I have an eye to make difference of men's liking" against what she actually said
needs to know what the speech is doing; ninety characters of it does not carry
that.

Three consequences, all of them favourable:

- **Context.** The model sees the whole speech and scores each beat inside it.
- **Volume.** ~1,705 beats live in ~1,060 blocks — roughly a 1.6× cut in calls.
- **Caching.** Nova supports prompt caching on `system` with a 5-minute TTL. The
  rubric is identical for every block in a scene, and blocks land well inside
  five minutes of each other, so the checkpoint actually hits rather than
  theoretically hitting.

**This does not change what gets scored.** CLAUDE.md's rule stands unmodified:
score per beat, render and display per block. The call is block-shaped; the
result is a per-beat score keyed on `line_id`, exactly as `scoreBeat` returns
today. Anything that reads `line_mastery` is unaffected.

## 3. The three bands

`confidence_score` is continuous and stays that way. The band is a *presentation*
of it:

| Band | Meaning | Roughly |
|---|---|---|
| **solid** | She had it | High recall, no material omission |
| **close** | She had the sense of it, not the words | The near-miss case Shakespeare makes the norm |
| **dry** | She didn't have it | Blank, or far enough off that it isn't the line |

*Dry* is a real theater term for forgetting a line, listed in the style guide §2
as vocabulary to borrow. That is the whole reason to prefer it over "missed" —
it is what someone in the wings would actually say.

**This changes the shape of `OPEN_ITEMS.md` §1a.** That item is written as a
single threshold: said, or missed. Three bands means **two** cuts, and the
solid/close cut is a different question from the close/dry one. The first is
"how much slack does a working actor deserve"; the second is closer to "did she
know this at all", which the capture layer already distinguishes at the source —
a skipped beat returns an empty `heard`, a fumbled one returns wrong words.

Neither cut is settled here, and neither should be guessed. `score.ts`'s
`SAID_IT_THRESHOLD` remains the placeholder it says it is.

## 4. Where it appears

**Under the block, not in a gutter.** A third column narrows the script, needs a
responsive answer, and fights the style guide's requirement (§8) that layout
survive 200% text scaling. Under the block follows reading order and reads better
in a recorded demo.

**The slot is reserved from the start.** Every one of her blocks renders with a
fixed-height annotation area, empty until the score arrives. Inserting content
after the fact would push the block she is currently reading down the page —
text moving under an actor mid-scene is the kind of thing that reads as a bug.
The cost is some vertical space on an unscored block; the benefit is a script
that never reflows.

**Non-interruptive, but not invisible.** This is the point on which the style
guide §9 changes, so the reasoning belongs here:

- Nothing blocks. Advancing to the next block never waits on a score.
- Nothing demands a response. She can ignore the entire column of annotations and
  the rehearsal is identical.
- No sound, and no motion that pulls the eye.
- The annotation is **clickable**: opening it pauses playback and shows the
  block's notes. That is opt-in, and pausing is the correct behaviour precisely
  *because* it is opt-in — she has chosen to stop and read.

The original §9 rule existed to stop the app interrupting an actor mid-scene.
That intent survives intact. What changes is the assumption that the only way to
honour it was to say nothing until the scene ended.

**Scores may arrive late, and that is fine.** An earlier draft of this design
leaned on the gap while Polly voices the next character, but that gap does not
always exist — she may have two blocks back to back, or be alone on stage. So the
slot fills in asynchronously and tolerates being a block behind. An unscored
block shows a quiet pending state, never a hole.

## 5. The two calls

They are different workloads and should not share a model.

**Per block — the live one.** Nova Micro, `us.amazon.nova-micro-v1:0`. High
frequency, latency-sensitive, text-only. Returns a band-driving score per beat
plus one short note for the block. See `clients/bedrock-client` for why this goes
through Converse on `bedrock-runtime` rather than `bedrock-mantle`, and
`configClient.ts` for why the `us.` geo-profile prefix is mandatory rather than
cosmetic.

**Per scene — the wrap-up one.** Once, at scene end. Reads every block's result
and writes the encouraging summary: what went well, what is worth another look,
what to run next. Low frequency, quality over latency — this is the slot
`BE_PLAN.md` §4 reserves for a stronger model, and the model for it is not chosen
in this doc.

**The summary is generated once and stored**, not regenerated on each view of the
wrap-up. Regenerating would bill a call on every refresh and produce different
words for the same rehearsal, which makes the wrap-up feel unreliable in exactly
the way a coaching note must not.

**`score.ts` does not go away.** It remains the fallback `BE_PLAN.md` §8 asks
for: if Bedrock is slow or down, the band comes from word recall and the scene is
never blocked. Its header already anticipates this — Bedrock replaces the
judgement, not the interface.

## 6. Schema and lifecycle

Three changes, one migration.

**The session row is created at rehearsal start, not at save.** Per-block writes
need somewhere to write. This deletes the end-of-scene transaction that currently
loops `scoreBeat` and an `INSERT` over every attempt at once, which was about to
become a loop of network calls inside an open serializable transaction.

It also fixes something already broken: today, abandoning a scene loses the whole
run. Incremental writes mean a partial rehearsal is still a rehearsal, which is
the more honest record of what she did.

The cost, accepted deliberately: abandoned sessions become real rows. Cleaning
them up is not solved here and does not need to be.

**`block_coaching`, keyed `(session_id, block_id)`**, holding the block's note.
`mistake_log` is per-beat and deliberately filtered to misses only — putting
notes there would bury the signal it exists for. The wrap-up reads this table
back to show every block scored, not only the flagged ones.

**A summary column on `session_history`** for the stored scene note (§5).

**The band is derived, not stored.** One less column, and the thresholds are
being actively tuned toward §1a. The tradeoff, stated so it is not discovered
later: **retuning a threshold silently re-bands every past session.** A run she
remembers as solid can become close. That is acceptable while the thresholds are
unsettled and the history is days old; it stops being acceptable once either of
those changes, and the fix at that point is to store the band at write time.

## 7. Auth

The capture socket has **no auth gate**, matching `/polly` and `/plays` —
rehearsing works fully as a guest. `session_history.user_id` is `NOT NULL`, so
there is nowhere to hang a guest's history.

Per-block writes put those in direct conflict. The resolution is that the socket
becomes **auth-aware but not auth-gated**: it reads the session cookie if one is
present.

- Signed in — score, display, persist.
- Guest — score, display, persist nothing.

A guest sees the same live coaching. Only the memory is missing, which is exactly
what "Save Progress" has always been offering.

## 8. Still open after this doc

- **Both cuts in §3**, which is `OPEN_ITEMS.md` §1a restated. Not guessable;
  needs real transcripts, which need real rehearsals.
- **The model for the scene summary.** Deliberately unchosen. Bedrock pricing for
  current models could not be verified from AWS's pricing page — it renders no
  figures for Nova or for any current-generation model — so `BE_PLAN.md` §7's
  "verify pricing at build time" remains genuinely outstanding rather than
  quietly assumed.
- **Whether Nova honours forced `toolChoice`.** Nova supports client-side tool
  calling but *not* structured outputs, so the response shape comes from a forced
  single-tool call. The model card does not state whether forcing is honoured.
  `BedrockClient.converseJson` falls back to scraping JSON from prose and reports
  it via `recoveredFromText`; if that ever comes back true, the toolChoice shape
  is wrong and the parser is not the thing to widen.
- **How many notes a long speech may produce.** `OPEN_ITEMS.md` §1c already
  answers this for monologues — cap them, rank by severity, rest to the Prompt
  Book. The same cap is needed here and is not yet applied.
- **Barge-in**, unchanged from `capture-plan.md` §8: if a click-to-pause
  annotation stops Polly mid-line, resuming needs to not re-trigger the mic on
  audio she has already heard.
