# Line sequencing — speech-level playback

*Deferred, pending user feedback. Written July 30 2026 after building and then
reverting a working implementation — the revert was to keep the change out of
the feedback round, not because it failed. Everything below was verified
against the real database and the live Polly/S3 cache.*

---

## 1. The problem

A speech that spans more than one line of verse plays as several clipped
utterances instead of one continuous delivery.

Observed in Act I Scene III — Falstaff's speech renders as three separate
blocks, each with its own repeated `FALSTAFF` speaker header, and the audio
stops and restarts between them:

```
FALSTAFF   Bardolph, follow him. A tapster is a good trade:
FALSTAFF   an old cloak makes a new jerkin; a withered
FALSTAFF   serving-man a fresh tapster. Go; adieu.
```

## 2. Root cause

`lines` holds **one row per line of verse/prose, not one row per speech**
(`001_init_schema.sql`; the importer increments `line_number` per line and
`speech_number` per speech — `buildRows.ts:176`). `speech_number` already
groups them correctly:

| speech_number | line_number | text |
|---|---|---|
| 3 | 3 | Truly, mine host, I must turn away some of my |
| 3 | 4 | followers. |

Two independent consequences:

- **Display** — the UI renders each row as its own block, repeating the
  speaker header mid-speech.
- **Audio** — Polly is asked to synthesize each row separately, so a row
  ending mid-sentence ("…some of my") gets a *sentence-final* falling
  intonation and a trailing pause. The jerkiness is baked into the audio
  file; it is not a playback-timing problem.

## 3. Design

Merge consecutive line-rows of the same speech into one dialogue entry, and
make that merged speech the unit of both display and Polly synthesis.

### 3a. Merge adjacent, never group by `speech_number`

**This is the part that is easy to get wrong.** 44 stage directions in *Merry
Wives* alone fall *inside* a speech (verified by query; the behaviour is
called out in the `stage_directions` comment in `001_init_schema.sql`). Those
must still split the speech in two so the direction stays in its right place.

Grouping by `speech_number` outright would swallow them. Instead, merge only
*adjacent* entries **after** the existing line/direction interleave — a
direction then sits between the two halves and breaks adjacency for free.

Verified working, both the merge and the split:

```
FALSTAFF (2 lines): Truly, mine host, I must turn away some of my followers.
Host     (3 lines): Thou'rt an emperor, Caesar, Keisar, and Pheezar. I will…

SPLIT speech #83 (FORD) by [Exit]
   part1 26L: What a damned Epicurean rascal is this! My heart is ready…
   part2  1L: Fie, fie, fie! cuckold! cuckold! cuckold!
```

Sketch, in `PlaysService`, run over the already-sorted interleaved list:

```ts
function mergeAdjacentSpeeches(entries: DialogueEntryRow[]): DialogueEntryRow[] {
  const merged: DialogueEntryRow[] = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (
      entry.type === "speech" && previous?.type === "speech" &&
      previous.speechNumber === entry.speechNumber &&
      sameSpeakers(previous.speakerIds, entry.speakerIds)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        lineIds: [...previous.lineIds, ...entry.lineIds],
        text: `${previous.text} ${entry.text}`,
      };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}
```

Requires `l.speech_number` added to the `SELECT`/`GROUP BY` in
`getSceneDialogue` and `getLine`.

Join the text with a **single space**. The row breaks are typographic verse
wrapping, not sentence boundaries — anything stronger makes Polly pause where
the line merely wrapped.

### 3b. API shape

`DialogueEntryRow`'s speech variant gains `lineIds: string[]` (whole block, in
order) and `speechNumber`, replacing the single `lineId`. Frontend
`DialogueEntry` keeps `lineId` as `lineIds[0]` — the stable identity for React
keys, mic state, and per-line flagging — and adds `lineIds` for playback.

Keeping per-line identity matters: `line_mastery` and `mistake_log` are keyed
per line, and that granularity is correct.

### 3c. Polly, keyed per speech

Replace `GET /polly/lines/:lineId/audio` with:

```
GET /polly/speech/audio?lineIds=a,b,c&characterId=…
```

The client sends the **exact ordered block**, because only the caller — which
performed the interleave — knows where a stage direction split a speech. The
server must not re-derive the block from `speech_number`.

Cache key: `{play}/{character}/{firstLineId}__{voiceId}__speech{n}.mp3`.

The line count belongs in the key on purpose. It creates a fresh namespace so
the old per-line objects can't be served as truncated first fragments, and a
re-import that moves a speech boundary produces a different key rather than
silently serving audio for the old grouping.

### 3d. Warm script must reuse the same grouping

`warmPollyCache.ts` has to walk scenes through `PlaysService.getSceneDialogue`
rather than querying `lines` directly. Slower, but it must produce
byte-identical grouping to the live endpoint — a warm run keyed even slightly
differently pays for a full synthesis pass and then misses on every real
request.

---

## 4. Cache migration — can the existing audio be reused?

Asked and tested. **The answer differs by block size.**

### Multi-line speeches: no. The fault is in the bytes.

Measured on the same 2-line speech, fragments vs. one correct render:

| | bytes |
|---|---|
| old fragment 1 — "Truly, mine host, I must turn away some of my" | 25,100 |
| old fragment 2 — "followers." | 6,668 |
| **sum if stitched** | **31,768** |
| new single render of the whole sentence | 25,532 |

Stitching yields **24% more audio than the correct render of the same words**,
and the surplus is dead air — a terminal pause Polly added to "…some of my"
because it was told to read it as a complete utterance, plus a sentence-initial
lead-in on "followers." Concatenation cannot remove either. You would be gluing
together two wrong performances, i.e. reproducing exactly the reported
jerkiness while merely saving the network round-trip.

(Secondary, and solvable, so not the deciding factor: MP3 encoder delay and
padding at each boundary make naive concatenation click unless you decode and
re-encode.)

### Single-line speeches: yes, 54% of them.

| | blocks | chars |
|---|---|---|
| single-line (text identical to existing cache, key changed only) | 599 (54%) | 20,376 |
| multi-line (must be re-synthesized) | 516 (46%) | 88,920 |
| **total** | **1115** | **109,296** |

Longest speech in the play: **37 lines.**

| approach | Polly cost |
|---|---|
| re-warm everything | **$3.28** |
| `CopyObject` the 599 single-line, synthesize the 516 multi-line | **$2.67** |

**Recommendation: just re-warm.** The copy path saves $0.61 and costs a
`copyObject` on `S3Client` plus a migration script that exists solely for this
one transition — any future play import warms from scratch anyway, so it earns
nothing afterwards.

```
deno task warm-polly-cache -- --play "The Merry Wives of Windsor" --yes
```

Not blocking: without re-warming, playback still works and simply pays
synthesis latency the first time each speech plays, caching from there.

---

## 5. Audio capture — thoughts, not yet designed

The same unit mismatch will bite harder on capture, and it should be resolved
the *opposite* way: playback wants the speech whole, capture wants it
**captured continuously but scored per line**.

Streaming a whole speech to Transcribe and diffing the transcript against the
full block yields one pass/fail for a 26-line Ford speech — useless for "which
bit did I dry on." `line_mastery` / `mistake_log` are per-line and that is the
right granularity; it is what makes "worth another look" actionable.

Proposed direction: capture continuously across the speech, then align the
transcript back onto individual line rows using Transcribe's word-level
timestamps — walk the expected line texts and attribute each mistake to the
row it falls in. She delivers the speech at natural pace; scoring stays
per-line.

Worth settling **before** building it: "one capture per line" is the tempting
shortcut and it makes a speech unspeakable at natural pace.

Also settle early: Shakespeare's verse means near-misses are the norm, so the
fuzzy-match threshold (does a dropped "the" count?) will matter more than the
capture plumbing. Related open question already logged in style guide §11 —
`confidence_score` is continuous, so a near-miss and a full blank currently
read identically.

---

## 6. Files touched by the reverted implementation

For whoever picks this up — this is the full blast radius.

**api**
- `src/features/plays/service.ts` — `speech_number` in queries, `lineIds` on
  `DialogueEntryRow`, `mergeAdjacentSpeeches`
- `src/features/polly/service.ts` — `getSpeechAudio`, `speechCacheKey`;
  retires `getLineAudio`/`cacheKey`; `warmLine` takes `lineIds: string[]`
- `src/features/polly/routes.ts` — `GET /speech/audio`
- `src/scripts/warmPollyCache.ts` — warms blocks via `getSceneDialogue`

**frontend**
- `src/data/pollyClient.ts` — `getSpeechAudio(lineIds, characterId)`
- `src/data/client.ts` — `RawDialogueEntry.lineIds`, map `lineId = lineIds[0]`
- `src/types/views.ts` — `DialogueEntry.lineIds`
- `src/pages/RehearsalPage.tsx` — call `getSpeechAudio(entry.lineIds, …)`

One orphaned S3 object exists from endpoint verification:
`…/falstaff/{lineId}__Brian__speech2.mp3`. Harmless; a future re-warm
recreates it under the same key.
