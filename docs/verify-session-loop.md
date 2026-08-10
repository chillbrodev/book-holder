# Verifying the session loop by hand

*What a person has to do that no test can. Written when the wrap-up stopped
showing fixtures; steps 3, 5 and 6 have never been done.*

Everything here needs a mic, a voice and a judgement call, which is why it is a
document rather than a test file. The parts that could be automated already are:
64 API tests, and the summary read verified against the live database — a
four-beat session with one fumble and one silence stored `beats_run` 4 (not 2)
and duration 412s, read back identically by session id and by latest-for-scene,
with the silence preserved as an empty string and a second user refused. Those
rows were deleted afterwards.

`session_history` was at **0 rows** when this was written, and no real rehearsal
has ever been saved — the write path is verified only by probes that cleaned up
after themselves. Step 4 is what changes that, and it is still the first thing
worth doing.

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

## 2. Rehearse a scene to the end

Shelf → *The Merry Wives of Windsor* → pick a part → pick a scene. The mic opens
only on her own lines.

**Fumble one beat and stay silent through another, deliberately.** Nothing lands
in `mistake_log` for a clean run, and the flagged list is most of what step 3
checks.

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
The rehearsal fires the session save and navigates without awaiting it, on
purpose; the wrap-up then reads immediately and beats a serializable transaction
that runs a query per beat. Unsynchronised, the read returns the previous run
under the heading "here's how the run went" — plausible on screen, and wrong.

Step 4 should now show two rows.

## 6. Guest state

Log out. Rehearse any scene to the end.

Pass: the wrap-up says *"This run wasn't saved…"*, shows no stat cards, and
disables "Practice these lines". Guests have nowhere to save to — `user_id` is
NOT NULL on all three tables — so this is correct, not broken.

Fail: an error screen, or statistics of any kind.

## 7. Static checks

```bash
cd api && deno check src/main.ts && deno task test && deno fmt --check src/
cd ../frontend && npx tsc -b && npx oxlint
```

64 API tests pass. The only expected lint output is the pre-existing
`useAsync` exhaustive-deps warning.

---

## What this still won't tell you

- **A real voice at length.** Every capture measurement used Polly as the
  speaker: no room noise, no hesitation, no half-restarted lines.
- **ALB idle timeout** on the deployed environment — the one capture question
  local work cannot answer at all.
- **Whether the flagged list stays readable on a rough run.** It is uncapped,
  unlike the plan's five beats (`MAX_EMPHASISED_BEATS`). A run that fumbled
  twenty beats has never been rendered.
