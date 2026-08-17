# Capture: how her voice gets from the mic to something scoreable

*Started August 7 2026. The first build of `OPEN_ITEMS.md` §1 (agentic coaching).
Capture comes first because nothing downstream — comparison, mastery, coaching
notes — can be built or even prompted for until there is a transcript aligned to
beats.*

`OPEN_ITEMS.md` §1b settled the *interaction* design: mic open across a whole
block, beats as scoring boundaries, alignment as a rolling fuzzy match. This doc
settles the *mechanics* underneath it, and records the measurements that decided
them so nobody re-derives them from scratch.

The backend plan listed "settle **streaming vs post-utterance** first" as a
blocking question. This is that decision.

---

## 1. The decision, in one table

| | Choice | Why not the obvious alternative |
|---|---|---|
| Service | **Amazon Transcribe, streaming** (`StartStreamTranscription`) | Batch can't say "Line?" mid-speech — §6 |
| Audio on the wire | **16 kHz, 16-bit signed LE, mono PCM**, from an `AudioWorklet` | `MediaRecorder` emits a container Transcribe won't accept — §3 |
| Transport browser→API | **WebSocket to our own API**, which holds the Transcribe stream | A presigned Transcribe URL is a spendable credential in the browser — §4 |
| Stream scope | **One Transcribe stream per block** | One per scene is 3.06× cheaper and was measured, but loses a whole run to one blip — §5 |
| Idle handling | **Silence keepalive frames** while she thinks | Transcribe closes a stream after 15s without audio, and "Line?" takes longer than that — §5.2 |
| Beat tracking | **Rolling fuzzy match of partials** against the block's expected beat texts | A Transcribe segment spans several beats, so splitting the transcript maps three beats onto one score — §7 |

---

## 2. What has actually been verified

Run against the real services from Deno 2.9.4, not reasoned from docs:

- **The AWS SDK's streaming client works under Deno.**
  `npm:@aws-sdk/client-transcribe-streaming@^3` loads, and its default
  `requestHandler` resolves to `NodeHttp2Handler`. This was the main feasibility
  risk: Deno lists `node:http2` as only *partially* supported, and at least one
  documentation summary claims `ClientHttp2Stream`'s methods are non-functional
  stubs. They are not, as of 2.9.4 — `http2.connect()` to
  `transcribestreaming.us-west-2.amazonaws.com` succeeds, `session.request()`
  returns a real `ClientHttp2Stream`, and `stream.write` is a function.
- **A full request reached the service and was rejected on IAM, not protocol.**
  `AccessDeniedException: … not authorized to perform:
  transcribe:StartStreamTranscription`. Getting that error is the good outcome:
  SigV4 signing, event-stream framing, HTTP/2 transport and response
  deserialization all worked end to end. Only the policy was missing.
- **Polly can produce the test fixture.** `OutputFormat: "pcm"`,
  `SampleRate: "16000"` returns exactly the format Transcribe streaming wants —
  1,415,200 bytes (44.2s) for one real 8-beat Mistress Ford block. So the capture
  path can be exercised deterministically, with no human in the loop and no
  recorded fixtures in the repo. Neural is byte-identical for identical input, so
  the fixture is stable across runs.

Once the IAM policy landed, the rest was measured against one real 8-beat
Mistress Ford block (II.i, 754 characters, 44.2s of Polly PCM), driven through the
actual `/capture` WebSocket at real-time pace:

- **Latency is comfortably live.** Partials arrive ~1.3–1.5s behind the audio
  position; a final lands within ~0.3–0.5s of its segment ending. Wall clock for
  the whole capture was 45.5s against 44.2s of audio.
- **`Stable` is a usable signal.** Across 83 partials, all but the last ~2 words
  were consistently flagged stable — so the cursor can move on committed text and
  leave the jitter to the tail.
- **The beat split is exact.** 8 of 8 beats got their own words, `beatsCompleted`
  reached 8, and the cursor never drifted or went backwards.
- **Word accuracy on Shakespeare is better than expected: 2.76% WER** — 4 errors
  in 145 words, with 6 of the 8 beats word-perfect. Transcribe got
  "uncomeliness", "I trow", "reproof" and "adhere" right unaided.
- **The keepalive works.** A deliberate 25-second silence mid-speech — five times
  Transcribe's tolerance — was survived, all 8 beats still captured, and it cost
  **1.0s of silence** (five 200ms keepalives), 2.3% on top of the real audio.
  Bonus: Transcribe finalizes the open segment when the silence arrives, so a
  pause acts as a free segment boundary.
- **The billing accounting is exact.** `secondsForwarded` reported 44.23 against
  44.2s of audio.

Audio here is Polly rather than a human, so this measures the *transport, the
alignment and the ASR floor* — not how the app copes with a real voice, a real
room, or a real actor's pacing. That pass still needs a person and a microphone.

---

## 3. Audio format: PCM off an AudioWorklet, not MediaRecorder

**This corrected an earlier plan** that called for a cross-browser
`MediaRecorder` check. `MediaRecorder` is the wrong tool here, and that check
would have validated the wrong thing.

Transcribe streaming accepts three encodings: `pcm`, `flac`, `ogg-opus`.
`MediaRecorder` emits none of them portably — Chrome gives
`audio/webm;codecs=opus`, Safari gives MP4/AAC, and only Firefox will produce
`audio/ogg;codecs=opus`. WebM is a *container*, and its chunks are not
independently decodable, so they cannot be re-framed into an audio stream without
demuxing them first. Picking `MediaRecorder` means either shipping a demuxer or
supporting one browser.

So: `getUserMedia` → `AudioContext` → `AudioWorkletNode`, which hands back
`Float32Array` blocks of 128 frames. Downsample to 16 kHz, convert to
16-bit signed LE, ship as binary WebSocket frames. 16 kHz because Transcribe
recommends it and it is a quarter of the bytes of 48 kHz for no accuracy loss on
speech.

**Two taps off one `MediaStream`**, not one. The wire wants raw PCM; the S3
session recording (`recordings` table, `BE_PLAN.md` §2) wants something a browser
can play back and something small enough to store. Raw 16 kHz PCM is 32 KB/s — a
20-minute rehearsal is 38 MB. The same session as Opus is under 4 MB and plays in
an `<audio>` element directly. So `MediaRecorder` still earns a place, just for
the archive rather than the wire, running in parallel off the same stream.

Practical notes for whoever builds this:

- `AudioWorklet` needs a **secure context**, already true (`PROJECT_PLAN.md` §9
  notes HTTPS is effectively a fixed cost here for exactly this reason).
- The worklet processor is loaded by URL, so it is a separate file, not a bundled
  module — it has to end up in the built output as its own asset.
- `AudioContext` starts suspended until a user gesture. The mic tap is behind the
  existing tap-to-start interaction, so this is not a new constraint, but it does
  mean `connecting` is a real state and not decorative.

## 4. Transport: our WebSocket, not Transcribe's

Transcribe streaming can be driven straight from a browser over its own
WebSocket API, using a SigV4-presigned `wss://` URL. That would remove a hop and
halve the bandwidth we pay for. It is still the wrong choice.

A presigned Transcribe URL does not leak the secret key, but it *is* a bearer
token for "open transcription streams on this account" for up to five minutes.
Handing that to a browser means the billing ceiling is whatever the holder feels
like spending, and the constraint in `BE_PLAN.md` §1 — no AWS credentials ever
reach `frontend` — exists precisely so that no client-side actor can spend
money. A signed *S3 GET* URL, which we do use, grants reading one object we
already paid to create; those are not comparable grants.

Holding the stream server-side also puts the beat cursor, the fuzzy match and
(later) the Bedrock comparison next to the expected beat text, which lives in the
database. The client would otherwise need the answer key to align against — and
the answer key is the thing she is being tested on.

Deployment consequence: the ALB that ECS Express Mode provisions supports
WebSockets, but **idle timeout applies**, and a rehearsal has long quiet
stretches while Polly is talking. §5.2's keepalive covers the Transcribe side of
this; the ALB side needs checking against a deployed environment before this is
called done.

## 5. Stream scope: one per block, and what that costs

### 5.1 The measurement

Every one of the 1,064 blocks in *The Merry Wives of Windsor* is already rendered
and cached in S3. Polly's MP3 output is constant-bitrate, so object size *is*
duration (`features/polly/audioDuration.ts`) — which makes the whole corpus a
free, exact sample of how long a block takes to speak:

| | |
|---|---|
| blocks | 1,064, 133.9 minutes of audio total |
| block duration | min 0.7s, **median 4.6s**, mean 7.6s, max 104.7s |
| **blocks under 15 seconds** | **950 of 1,064 — 89%** |

That 15-second line matters because Transcribe bills "in one-second increments,
with a minimum per request charge of 15 seconds", and a streaming *session* is
one request. A stream per block therefore pays the floor on nine blocks out of
ten.

Measured against the character a user would actually rehearse, per scene, with
her blocks' real durations:

| scene | blocks | beats | her speech | billed, per-block | $/run | $/run, one stream |
|---|---|---|---|---|---|---|
| II.i | 13 | 25 | 105s | 224s | $0.090 | $0.042 |
| III.iii | 33 | 44 | 160s | 501s | $0.200 | $0.064 |
| IV.ii | 31 | 37 | 138s | 465s | $0.186 | $0.055 |
| IV.iv | 3 | 3 | 15s | 45s | $0.018 | $0.006 |
| V.iii | 4 | 5 | 11s | 60s | $0.024 | $0.006 |
| V.v | 5 | 7 | 19s | 75s | $0.030 | $0.007 |
| **whole part** | **89** | | **7.5 min** | **22.8 min** | **$0.55** | **$0.18** |

The floor costs **3.06×** the audio for Mistress Ford — the multiplier is worst
for exactly the characters worth rehearsing, because their parts are dialogue
(many short blocks) rather than oratory. Across all characters it ranges 1.8×
(Falstaff, who speaks in paragraphs) to 3.1×.

**This redoes the cost line `BE_PLAN.md` §4 asked to have redone.**
`PROJECT_PLAN.md` §9 estimated $3–4/month for Transcribe by assuming ~130 billed
minutes; the shape is right and the reasoning ("driven by the per-request
minimum, not audio length") was exactly correct. Concretely: a full scene run
costs $0.02–$0.20, so 20 rehearsals a month of the biggest scene is ~$4.00
per-block against ~$1.28 with one stream.

One caveat on the rate: $0.024/min is the figure `PROJECT_PLAN.md` §9 uses and
the one most sources quote for standard tier 1, but AWS's own pricing page
currently shows a worked example at $0.01/min for streaming in us-east-1.
The *ratios* above hold either way. Confirm the absolute rate against the
pricing page and the first real bill before quoting a monthly number.

### 5.2 Why per-block anyway

One stream per scene is three times cheaper, still live, and was seriously
considered. Per-block wins on grounds other than cost:

- **A failure loses one block, not the run.** A dropped stream mid-scene with the
  session-scoped design means the rest of the rehearsal captures nothing, and the
  user finds out at the wrap-up. Per-block, the same blip costs her one speech
  and the next one reconnects clean.
- **The block is already the unit of everything else** — one Polly render, one
  display card, one mic open (§1b). A stream whose lifetime matches the
  interaction needs no bookkeeping to map results back onto blocks; a
  session-scoped stream needs offset tracking against the stream's own timeline.
- **The absolute number is small.** $0.02–$0.20 per scene run does not justify
  the coupling.

Recorded here with its measurement so that if the Transcribe line ever does
matter, the 3.06× is already quantified and the option doesn't need re-deriving.

**The 15-second idle timeout applies either way.** Transcribe closes a stream
that goes 15 seconds without audio, and the rehearsal is full of legitimate
silences longer than that: she is thinking, or she tapped "Line?" and is reading
the beat that came back. So silence frames go through the gaps rather than
nothing — generated **server-side** (`AudioQueue`), because a client that has gone
quiet is one of the cases this protects against and therefore cannot be the thing
responsible for preventing it.

**Verified:** a 25-second mid-speech silence was survived with all 8 beats still
captured, at a cost of 1.0s of silence (2.3% of the block's audio). Transcribe
treats sparse silence as a live stream, and finalizes the open segment when it
arrives.

## 6. Alternatives, and why not

- **Transcribe batch, once per session.** Cheapest of everything: one request,
  one floor, her speech only. It cannot support the product. "Line?" has to feed
  the *next beat* while she is still standing there mid-speech (§1b), and a
  wrap-up-only report is a grading service, not a rehearsal partner.
- **Transcribe batch, once per block.** Post-utterance, no partials. Kills the
  beat cursor for the same reason, and costs the same as streaming.
- **Bedrock Nova Sonic** (speech-to-speech, bidirectional streaming) would
  collapse capture and coaching into one connection, and is genuinely the more
  modern shape. Rejected for now on the same grounds the Polly engine choice
  turned on (`docs/polly-gen-issue.md`): it is an LLM, so it is
  non-deterministic, and it returns *conversation*, not a timestamped transcript
  with per-word stability. Scoring a beat needs to know what she said, not a
  friendly paraphrase of it, and the fuzzy-match threshold (§1a) is meaningless
  without a literal transcript to threshold against. Worth revisiting for the
  coaching *conversation* later — it is the wrong tool for the measurement.
- **The browser's own `SpeechRecognition`.** Free and live. Chrome-dependent,
  ships her audio to Google, and gives no word-level stability. A zero-cost
  degraded fallback at best, not the path.

## 7. The beat cursor

The mic is open for a block; the block has an ordered list of expected beat
texts; partial results arrive continuously. The cursor is the index of the beat
she is currently believed to be on.

Alignment is a **rolling fuzzy match**, not a split of the transcript. As
partials extend, match the tail of the stabilized transcript against the expected
text of the current beat; when the match has consumed enough of that beat, and
the following words start matching the *next* beat, advance the cursor. This is
what lets "Line?" hand over the next beat rather than the whole speech, and it is
why beats are scoring boundaries rather than interaction boundaries — nothing
stops at a beat edge.

**A Transcribe segment is not a beat, and this is not a small discrepancy.** The
8-beat block came back as **6 segments, one of which spanned three beats on its
own**. Transcribe segments on its own pause and punctuation logic, which has no
knowledge of where a thought ends. This is the empirical confirmation of the
`OPEN_ITEMS.md` §1b decision to align by rolling fuzzy match rather than by
splitting the transcript — a split on segment boundaries would have mapped three
beats onto one score.

It also caught a real bug during this pass: `CaptureSession` was aligning each
segment's transcript against the whole block independently, which restarted
`heardByBeat` from empty at every segment boundary and would have reported only
the final segment's words. Finalized segments are now accumulated and the current
partial appended, which is what produced the exact 8-of-8 split above.

Three more things make this harder than it sounds, all worth knowing up front:

- **Beat text repeats within a block.** In Merry Wives II.i, "How shall I be
  revenged on him?" is beat 6 of Mistress Ford's 8-beat block *and* beat 13 of
  Mistress Page's 14-beat block. Alignment has to be monotonic — a cursor that
  can only move forward — rather than a search for the best match anywhere in the
  block, or a repeated phrase will drag it backwards.
- **Scoring must not read partials as misses.** A partial is a guess that the
  next partial may revise. Only `IsPartial: false` results, or items flagged
  `Stable`, are evidence about what she said. Everything else is for the cursor
  and the UI.
- **She can skip a beat entirely**, which moves her dozens of words past the
  cursor in one go — further than any word-level tolerance can absorb. Forgetting
  a thought and carrying on is a normal rehearsal failure, and a cursor that
  stalls on the abandoned beat attributes the whole rest of the speech to it,
  turning one skip into every following beat reading as wrong. `beatCursor.ts`
  handles it with a forward-only resync that requires three consecutive matching
  words before it will jump — one word matches by chance constantly across a
  150-character beat.

Deliberately *not* settled here: the fuzzy-match threshold itself
(`OPEN_ITEMS.md` §1a), which is a product question about how the app should feel
and belongs with the comparison prompt, not with the transport. Capture's job is
to deliver a faithful transcript with beat boundaries attached; what counts as a
miss is decided downstream.

**"Downstream" now means *on this socket*, not an hour later in a POST** — see
`docs/coaching-plan.md`. Scoring happens when the block finishes, because the
`complete` event already carries exactly the (expected, heard) pairs it needs and
the expected text was loaded server-side by `getBlockBeats`. Two consequences for
this document:

- **The partials rule above gets sharper, not softer.** It used to be that a
  partial mistakenly treated as final would produce a wrong score in a POST some
  minutes later. Now it produces a wrong band under her block while she is still
  in the scene. `IsPartial: false` remains the only evidence about what she said.
- **The socket becomes auth-aware, but stays un-gated.** It verifies a Supabase
  access token if one is offered: signed in, results are persisted; guest,
  results are shown and discarded. Rehearsing as a guest still works fully,
  which is the property §4's no-auth decision was protecting.

  The token arrives as a WebSocket subprotocol — the client offers
  `["bearer", "<jwt>"]` and the server echoes the `bearer` sentinel. Not a
  header, because a browser `WebSocket` has no way to set one; not a query
  parameter, because a URL is written into every access log between here and
  the ALB, which would turn each rehearsal into a logged credential. An
  *invalid* token is treated exactly like an absent one: her session expiring
  mid-speech must cost her the writing-down, not the take.

## 8. Still open after this doc

- **Number normalization is the one real error class, and it is not a threshold
  problem.** Measured, the archaic vocabulary was mostly a non-issue — Transcribe
  got "uncomeliness", "I trow", "reproof" and "adhere" unaided. All 4 errors in
  145 words fell in two beats:

  | expected | heard | why it matters |
  |---|---|---|
  | "than the **Hundredth** Psalm" | "in the **100** Psalm" | Transcribe writes numerals; the text writes words. **Deterministic** — it will misread this line every single time she says it correctly |
  | "**threw** this whale" | "**through** this whale" | homophone; 2 edits apart, so the word tolerance won't absorb it |
  | "so many **tuns** of oil" | "so many **tons** of oil" | homophone, 1 edit — already absorbed by `wordsMatch` |

  The "Hundredth"/"100" case is the important one, because it is repeatable rather
  than random: no threshold can be set that both accepts it and catches a real
  miss. It has to be fixed in normalization or upstream, not tuned around.
  **Transcribe custom vocabulary is the likelier lever than digit-to-word
  mapping** — a vocabulary term biases the recognizer toward "Hundredth" at the
  source, where a mapping has to guess whether "100" meant "hundred", "hundredth"
  or "a hundred". A vocabulary built from the play's own text is derivable at
  import, from data already in hand. Not yet tried; it needs a vocabulary resource
  and another IAM action.
- **Sensitivity to where segment boundaries fall.** In the silence-gap run, beat 7
  came back missing its leading "I" ("think the best way…") where the continuous
  run had it. One unstressed pronoun, and the resync handled it — but it shows the
  per-beat text isn't perfectly stable across different segmentations of the same
  speech, which is worth knowing before treating a single word as evidence of
  anything.
- **ALB idle timeout** against a deployed environment (§4). The only capture
  question left that local verification cannot answer.
- ~~**A pass with a real voice.**~~ **Done.** Everything in §2 was measured
  against Polly, a deterministic stand-in with no room noise, hesitation, or
  half-restarted lines. Real rehearsals have since run end to end and the capture
  path held up. What that unblocked is the fuzzy-match threshold (`OPEN_ITEMS.md`
  §1a), which now has real transcripts to fit against rather than guesses, and is
  still unset.
- **Barge-in.** Nothing yet stops Polly's audio for the previous character
  bleeding into her mic and being transcribed as her words. Echo cancellation in
  `getUserMedia` constraints is the cheap first answer; headphones are the real
  one. Coaching adds a second case: a click-to-pause annotation
  (`coaching-plan.md` §4) stops playback mid-line, and resuming must not re-feed
  the mic audio she has already heard.
- **The silence windows are guesses.** `SILENCE_MS` 2500 and
  `AUTO_FINISH_SETTLE_MS` 900 in `useMicCapture.ts` were chosen, not measured.
  Whether 2.5s clips a breath taken mid-thought is unknown and needs a person
  rehearsing, not a probe — a stand-in voice never pauses to think.
  *(Carried forward from `docs/HANDOFF.md` before that document was deleted.)*
