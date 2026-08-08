# Hand-off — August 7 2026

*Written at the end of the session that built capture and the session write.
Branch: `listen-to-her-lines-and-track-beats`, seven commits ahead of `main`, not
pushed, not merged.*

This is a pointer document, not a duplicate. The reasoning lives in the commit
messages and in `capture-plan.md` / `OPEN_ITEMS.md`; what's here is state, order of
work, and the things that would cost someone a day to rediscover.

---

## 1. Where the agentic loop actually stands

`PROJECT_PLAN.md` §2's loop is **read memory → decide → act → write memory**. It is
now mostly built and almost entirely invisible, which is the central problem to
solve next.

| Stage | State |
|---|---|
| **read** memory | `GET /sessions/plan` built and verified — **nothing in the frontend calls it** |
| **decide** | the plan orders her weakest beats; nothing consumes the ordering |
| **act** | real: Polly voices the other parts, Transcribe listens to hers |
| **write** memory | real: `session_history` + `line_mastery` + `mistake_log`, one serializable transaction |
| **coaching note** | **not built.** Bedrock is not installed at all |

The wrap-up screen still reads `frontend/src/data/mock/*`, so it shows fabricated
duration, beats-run and flagged lines even though the rehearsal that preceded it
wrote real ones.

**So: both halves of the loop exist, and a demo can't show either.** That is the
gap, not missing plumbing.

## 2. What got built this session

Six commits of behaviour change (the seventh is this document), each with the
reasoning in its message — read those rather than trusting this summary:

1. **Capture** — mic → `AudioWorklet` → 16 kHz PCM → WebSocket → Transcribe → a
   beat cursor. Design and every measurement in `docs/capture-plan.md`.
2. **Preview page deleted** — it was rendering one play's speeches under another
   play's title. Postmortem in `OPEN_ITEMS.md` §3.
3. **Mic takes its cue from silence**, not from matching text.
4. **Session writes** — the write half of the loop.
5. **Header alignment.**
6. **Scene navigation** on the wrap-up: next/previous both in play order and in her
   part.

## 3. Verified vs not — read this before trusting anything

Measured against the real services, not reasoned from types:

- Capture end to end: **8 of 8 beats split correctly, 2.76% word error rate** on
  real Shakespeare, partials ~1.4s behind the audio, a deliberate 25-second silence
  survived for 1.0s of keepalive cost.
- Session write: all three tables commit together; a second run accumulates
  `mistake_count` rather than resetting it; a throwing transaction rolls back
  leaving nothing; guests get a clean 401; full HTTP round trip works.
- Scene neighbours: correct across all 23 scenes of Merry Wives.
- Header: all four items report identical `top` and `height`.

**Not verified, and don't claim otherwise:**

- **Anything with a real voice at length.** All capture measurements used Polly as
  the speaker — no room noise, no hesitation, no half-restarted lines. A few real
  runs happened by hand and surfaced two bugs, but nothing systematic.
- **The silence windows.** `SILENCE_MS` 2500 and `AUTO_FINISH_SETTLE_MS` 900 in
  `useMicCapture.ts` are guesses. Whether 2.5s clips a breath mid-thought is
  unknown and needs a person.
- **ALB idle timeout** on a deployed environment. WebSockets are supported; the
  timeout against long quiet stretches while Polly talks is untested. The only
  capture question local work cannot answer.
- **Whether a Transcribe custom vocabulary fixes numeral normalization** (§5).

## 4. What to do next, in order

### 4a (first, and it takes five minutes). Run one scene to the end as `jonman`

`session_history` is at 0 rows — no real rehearsal has ever been saved. Everything
in §3 about the write path was verified by probes, not by use. Confirm a real run
lands a row before building on top of it, and note whether the 2.5s silence window
feels right while you're there.

### 4b. Make the wrap-up tell the truth, and give a coaching note

One pass, because they are the same screen and the same request — a coaching note
above fabricated statistics would be incoherent.

- A session-summary read endpoint: real duration, beats run, and the beats actually
  flagged, from `session_history` / `line_mastery` / `mistake_log`.
- Then the **Bedrock coaching note** — the low-frequency call, summarising the
  session against her history. This is the most visibly agentic artifact in the
  product and none of it exists.

Note the coaching note does **not** depend on the §1a threshold, so it is not
blocked by §5 below.

### 4c. Surface the plan at scene start

`GET /sessions/plan` works and returns the right beats — verified: after a run
where beat 3 was skipped and beat 5 fumbled, it emphasised exactly those two, at
confidence 0.00 and 0.21. Nothing calls it. Showing "here's what I noticed last
time, let's watch these" is the *read memory → decide* half made visible, and needs
no Bedrock.

### 4d. Bedrock comparison, replacing the deterministic scorer

Deliberately last, and gated on §5.

## 5. The two things that need a human, not an agent

**Bedrock model access must be granted per-model in the AWS console.** No agent can
do this. Nothing in §4b works until it is. Also needed: the SDK in `api/deno.json`,
`bedrock:InvokeModel` in both `infra/aws/create-dev-user.sh` and
`infra/aws/ecs-deploy.sh` (same shape as the Transcribe grant added this session —
re-run the dev-user script after), and `BEDROCK_MODEL_ID_COMPARISON` /
`BEDROCK_MODEL_ID_SUMMARY` in `.env`, which exist but are **empty**. Verify model
IDs and pricing against the AWS docs at build time rather than from memory —
`BE_PLAN.md` §7 asks for this explicitly.

**The fuzzy-match threshold, `OPEN_ITEMS.md` §1a.** Still the biggest open question
in the product, and it is a judgement about how the app should *feel* that only
someone rehearsing can make. It is now answerable from data rather than guesswork:
`SAID_IT_THRESHOLD` in `features/sessions/score.ts` is 0.7 and its comment says
plainly that this is a placeholder, not the answer. Recall is recorded on every beat,
so the distribution needed to choose accumulates by itself.

One finding already constrains it: the ASR floor is 2.76% word error rate, so the
threshold has to sit above that — but at least one error class is **deterministic**,
not random. `"the Hundredth Psalm"` transcribes as `"the 100 Psalm"` every single
time. No threshold can both accept that and catch a real miss, so it has to be fixed
upstream (custom vocabulary is the likelier lever than digit-to-word mapping, and is
untested). **137 of 1,705 beats (8.0%) contain a number word** — that is an upper
bound on exposure, not a measured error rate; exactly one real failure has been
observed.

## 6. Traps found this session, worth not rediscovering

- **A Transcribe segment is not a beat.** One 8-beat speech returned as 6 segments,
  one spanning three beats. Aligning per segment restarted the per-beat split at
  every boundary. Accumulate finalized segments and append the live partial.
- **A hyphen is a word boundary, not punctuation.** `"well-behaved"` normalized to
  one token can never match the two words a transcript produces, at any edit
  distance. 169 of 1,705 beats (9.9%) contain a hyphenated compound; every one was
  a guaranteed mismatch in both the cursor and the scorer.
- **Transcribe hangs up after 15 seconds without audio**, and a rehearsal exceeds
  that legitimately every time she thinks or reads a revealed beat. Silence
  keepalives are generated **server-side** in `AudioQueue`, because a client that
  has gone quiet is one of the cases being protected against.
- **Deno's `node:http2` works** despite being documented as only partially
  supported — the Transcribe streaming SDK runs on it. Re-check on a Deno upgrade;
  the failure mode would be a transport error on every capture, invisible to a type
  check.
- **89% of blocks are under 15 seconds** (median 4.6s), so per-block Transcribe
  streams pay the 15-second billing minimum on nine blocks in ten — 3.06× the audio
  for Mistress Ford. Accepted deliberately; the 3.06×-cheaper session-scoped
  alternative is quantified in `capture-plan.md` §5 so it needn't be re-derived.
- **Don't trust checked-in fixtures.** The deleted preview page's fixtures had gone
  *semantically* stale — not just stale ids — and silently rendered the wrong play.
  A fixture beside the code it feeds has no mechanism telling it the rules changed.
- **CSS specificity bit once:** `.navLinkActive::after` at (0,1,1) lost to
  `.headerItem[data-interactive]::after` at (0,2,1), and the active underline
  vanished with no error anywhere. Found only by looking at the rendered page.

## 7. Running it

```bash
npm run dev          # frontend :5173 + api :8000, from the repo root
```

There is **one account** (`jonman`), created this session — `users` was empty
before it. Rehearsing works as a guest but saves nothing; the schema has nowhere to
put it.

**No real session has been written yet.** `session_history` and `line_mastery` are
both at 0 rows. The write path is verified, but only by probes that cleaned up after
themselves — capture was tested by hand *before* the write existed, and no
rehearsal has been run to the end of a scene since. So the first thing worth doing
is a full scene run as `jonman` to confirm a real rehearsal lands a row. Until that
happens there is also no accumulated recall distribution, which is what §5's
threshold decision needs.

To reach a mic: Shelf → *The Merry Wives of Windsor* → pick a part → pick a scene.
The mic opens only on her own lines. A dev-only line under the live speech shows mic
state, beat position and the live transcript (`CaptureDebugInfo`, dropped from
production builds).

**AWS state:** `transcribe:StartStreamTranscription` is granted to the local dev
user and the ECS task role. The whole Merry Wives Polly cache (1,064 blocks) is
warm, so playback is a signed-URL lookup, not synthesis. Nothing here is deployed —
this branch has not been pushed, so the deployed API predates all of it.

## 8. Loose ends

- `packages/play-importer/output/` was cleared and is regenerable with
  `npm run import:play -- --play merry_wives_of_windsor --dry-run` — the importer
  fetches the XML from a public URL, so no local input is needed. Nothing currently
  depends on it; it matters again at the next parser change.
- **Recordings are tabled**, not rejected — `OPEN_ITEMS.md` §1e records why, what
  they would have been worth (ground truth for the transcript, which is what §1a
  actually lacks), and the three decisions needed if picked up. Cost is not one of
  them: 1.8 MB per full run, under a penny a month.
