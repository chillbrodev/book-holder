# Verifying the session loop by hand

*What a person has to do that no test can. Written when the wrap-up stopped
showing fixtures; steps 3, 5 and 6 have never been done.*

Everything here needs a mic, a voice and a judgement call, which is why it is a
document rather than a test file. The parts that could be automated already are:
68 API tests, three real-service probes (see step 7), and the summary read
verified against the live database — a
four-beat session with one fumble and one silence stored `beats_run` 4 (not 2)
and duration 412s, read back identically by session id and by latest-for-scene,
with the silence preserved as an empty string and a second user refused. Those
rows were deleted afterwards.

`session_history` was at **0 rows** when this was written and is at 0 rows again as of
August 11 2026 — a day of debugging filled it with fragments, and they were deliberately
wiped so the first real rehearsal is the first real row. No genuine rehearsal has ever
been saved. The write path is verified only by probes that clean up after themselves.
Step 4 is what changes that, and it is still the first thing worth doing.

**It now pays for itself twice.** Per-block coaching (`coaching-plan.md`) needs
real (expected, heard) pairs to place the two threshold cuts in `OPEN_ITEMS.md`
§1a, and every beat scored here produces one. Until a scene is actually run, both
cuts are guesses.

---

## 0. Start it

```bash
npm run dev          # frontend :5173 + api :8000, from the repo root
curl -s localhost:8000/health
```

## 1. Sign in

There is one account, `jonman`. **If the PIN isn't remembered, register a new
account rather than guessing** — five failed attempts locks it for 15 minutes
(`MAX_FAILED_ATTEMPTS` / `LOCKOUT_MINUTES` in `features/auth/service.ts`). PINs
are 4–8 digits. A fresh account loses nothing: the history is empty either way.

## 2. Rehearse a scene

**"To the end" is a bigger ask than it sounds.** `completed_at` is only set when every
block in `session_block` has all its beats scored, and Shallow in I.i is **29 speeches**.
For a genuinely complete run use **Shallow, Act IV Scene II — 2 speeches, 2 beats**, which
takes under a minute. Doing one of each is better test data than either alone: a partial
run is now a kept rehearsal rather than a lost one, and that is worth seeing.

Everything valuable is written **per block as it finishes**, so stopping early costs only
`completed_at` and the duration.

**What to watch for during the scene**, all of which is new since this doc was written:

| | |
|---|---|
| ~1s after each speech | the grey slot fills with one pill per beat — gold *solid*, ash *close*, terracotta *dry* |
| a speech that went fine | advances by itself in ~900ms, nothing asked of you |
| a speech with a close/dry beat or a note | the scene **holds**, the dial says "Have a look — then carry on", and a **Continue** button appears (auto-continues after 6s) |
| a note | rare by design — ungrounded ones are dropped server-side, so most holds come from a band rather than a note |


Shelf → *The Merry Wives of Windsor* → pick a part → pick a scene. The mic opens
only on her own lines.

**Fumble one beat and stay silent through another, deliberately.** Nothing lands
in `mistake_log` for a clean run, the flagged list is most of what step 3 checks — and
`mistake_log.embedding` is the vector column the coach agent will search. A clean run
leaves it as empty as it is now.

The two are different failures on purpose: a fumble stores what you actually said and
gets embedded; a silence stores an empty string and is deliberately *not* embedded, since
a blank has no content to cluster on. Both should appear in step 4.

While in there, note whether the 2.5s silence window (`SILENCE_MS` in
`useMicCapture.ts`) clips a breath mid-thought. That is a feel judgement, it is
still a guess, and only someone rehearsing can settle it.

## 3. Read the wrap-up

The screen showed a fixed 6 minutes and two hard-coded lines from Act II Scene 1
for every run of every scene until recently, including runs that were never
saved. What it should show now:

| | Pass | Fail |
|---|---|---|
| Duration | roughly the time actually spent | `6 min`, or a number unrelated to the run |
| Beats run | a real count | an em dash — means `beats_run` came back null, which should be impossible for anything written from now on |
| Worth another look | the beats actually fumbled, in the order spoken | two fixed lines regardless of the scene rehearsed |

## 4. Confirm the row landed

```bash
node -e "
require('dotenv').config();
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.COCKROACHDB_URL});
p.query(\`SELECT s.started_at, s.act, s.scene_range, s.duration_seconds, s.beats_run,
  (SELECT count(*) FROM mistake_log m WHERE m.session_id=s.id) AS flagged
  FROM session_history s ORDER BY s.started_at DESC LIMIT 5\`)
 .then(r=>{console.table(r.rows);return p.end()});
"
```

Run from the repo root — it resolves `pg` and `dotenv` out of the root
`node_modules`, and reads the root `.env`.

One row, `beats_run` filled, `flagged` matching what the screen said.

## 5. Rehearse the *same* scene again — the race check

**The most important step, and the only way to catch this failure.**

Make the second run obviously shorter than the first. The wrap-up must show the
*second* run's duration.

If it shows the first run's numbers, `pendingSessionSave.ts` isn't doing its job.

**The race is much smaller than when this was written, and worth understanding rather
than assuming.** The beats are already stored — each block was written as it finished — so
what the wrap-up now races is only the *closing* call that records the duration and
`completed_at`. The failure mode is therefore no longer "the whole previous run" but "this
run with a missing duration", which is quieter and easier to miss.

Step 4 should now show two rows.

## 6. Guest state

Log out. Rehearse any scene.

Pass, **during** the rehearsal: a quiet ash notice under the scene strip saying *"This run
won't be saved"*, dismissible, and **the coaching still works exactly as it does signed
in** — pills, holds and all. That is §7's design, not a degraded mode: a guest gets the
mic, the other parts and the same judgement, and only the memory is withheld.

Pass, at the wrap-up: *"This run wasn't saved…"*, no stat cards, "Practice these lines"
disabled. Guests have nowhere to save to — `user_id` is NOT NULL on all three tables.

Fail: an error screen, statistics of any kind, or **no pills during the scene** — that
last one would mean the socket is refusing to coach an unauthenticated caller, which it
must not.

*(This is the one path never verified by a machine here: checking it means logging out,
and logging back in needs the PIN.)*

## 7. Static checks

```bash
cd api && deno check src/main.ts && deno task test && deno fmt --check src/
cd ../frontend && npx tsc -b && npx oxlint
```

68 API tests pass. The only expected lint output is the pre-existing
`useAsync` exhaustive-deps warning.

There are also three probes that hit real AWS and the real database. They are **billed**,
which is why they are tasks rather than tests — but each one covers something no unit test
can, and the socket one exists because a bug shipped that it would have caught:

```bash
cd api
deno task test-coach-block       # the rubric, against real Nova. Fails on an ungrounded note
deno task test-capture-socket    # ready -> complete -> scored over the real socket
deno task test-session-lifecycle # the writes, against the real DB, cleaning up after itself
```

**Re-run `test-capture-socket` after any change to the capture route.** It was written in
one commit and the route changed in the next without it being re-run; the result was a
cookie read after the WebSocket upgrade that broke every capture in the app and reported
itself as "Can't hear you — check your mic".

---

## What this still won't tell you

- **A real voice at length.** Every capture measurement used Polly as the
  speaker: no room noise, no hesitation, no half-restarted lines.
- **ALB idle timeout** on the deployed environment — the one capture question
  local work cannot answer at all.
- **Whether the flagged list stays readable on a rough run.** It is uncapped,
  unlike the plan's five beats (`MAX_EMPHASISED_BEATS`). A run that fumbled
  twenty beats has never been rendered.
