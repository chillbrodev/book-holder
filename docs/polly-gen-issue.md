# The text-to-speech engine said something Shakespeare didn't write

*How a line of *The Merry Wives of Windsor* acquired a sentence about Saint George, and why nothing in the system could have caught it.*

---

## The report

A cached line played back wrong. The block was `ea10da22-51fc-5c42-97d5-0662eb3c970a` — Sir Hugh Evans, Act I Scene I, beat 8:

> The dozen white louses do become an old coat well; it agrees well, passant; it is a familiar beast to man, and signifies love.

The audio said all of that, correctly, and then kept going. Transcribed by ear, the extra was:

> …I take a note to the parade of the madness drestar by Ben Kim, the first Christian Saint George. And there I lie mouth

That text is not in the play. It is not in the database. It is not anywhere in the corpus. It existed only in the MP3.

The natural first assumption is a data problem — a bad import, a mis-parsed source file, two lines spliced together. That assumption is wrong, and ruling it out is most of the story.

---

## The investigation

### Text-to-speech doesn't invent things. Except when it does.

The starting premise was that Amazon Polly is deterministic: hand it a string, get back that string spoken. Under that premise the extra words *must* have been in the input at synthesis time, so the job is to find out how the input differed from what's in the database now.

Four hypotheses, in order of plausibility.

**1. The database is wrong.** Checked first. The block is a single beat, and its stored text is exactly the line above — no extra clause, no trailing junk.

**2. The words came from somewhere else in the play.** Searched `lines` and `stage_directions` for every distinctive token: *George*, *Christian*, *parade*, *madness*, *Kim*, *Saint*, *lie mouth*. The only hits were genuine and unrelated ("Good George, be not angry", "It is spoke as a Christians ought to speak"). Nothing resembling the fabricated sentence exists in the corpus.

**3. Two adjacent blocks got spliced.** The block's neighbours are Shallow's *"It is an old coat"* before it and *"The luce is the fresh fish; the salt fish is an old coat"* after. Neither is the extra text. Not a splice.

**4. The cache served audio from an older version of the line.** This is the interesting one, and it's structurally impossible here. Block IDs are content-derived — a UUIDv5 over:

```
playTitle | act | scene | blockIndex | speakers | text
```

The text is *in the hash*. Change a word and you get a different ID, which means a different S3 key, which means a guaranteed cache miss and a fresh render. Stale audio cannot hide behind a live ID. (The ID scheme has also existed in exactly one version since it was introduced, so it never shifted underneath the cache either.)

All four ruled out. The text path was clean. Which meant the premise was wrong.

### Measuring the artifact

The cached object was 127,484 bytes. Parsing the MP3 frame header — Polly returns MPEG-2 Layer III at 48 kbps, 24 kHz, so 6,000 bytes per second — that's **21.2 seconds** of audio for 126 characters of text.

For comparison, the same string re-synthesized three times:

| run | bytes | duration |
|---|---|---|
| 1 | 55,772 | 9.3s |
| 2 | 53,900 | 9.0s |
| 3 | 59,660 | 9.9s |
| **cached** | **127,484** | **21.2s** |

Two things fall out of that table at once. The cached render is well over twice the length it should be — and **the three fresh renders don't match each other**. Identical input, three different outputs.

That is not how text-to-speech is supposed to behave, and it is the actual answer.

### The engine

```ts
Engine: "generative",
```

Polly's generative engine is LLM-based speech synthesis, chosen originally because it's the most expressive voice AWS offers. It is also non-deterministic, and like any autoregressive model it can fail to stop. Handed unusual text, it drifts off-distribution and keeps generating — producing fluent, confident, entirely invented speech.

The same test on the neural engine:

| engine | run 1 | run 2 | run 3 |
|---|---|---|---|
| generative | 53,180 | 55,196 | 53,468 |
| **neural** | **65,132** | **65,132** | **65,132** |

Byte-identical. Same md5. Neural cannot drift, because it produces the same bytes every time.

### How widespread was it?

Rather than trusting one example, the whole cache got audited: 1,064 cached renders, each one's duration compared against what its character count predicts.

Across 720 blocks longer than 40 characters, speech lands at **13.9 characters per second** (p05 10.3, p95 17.3). Modelling expected duration as `0.8s + chars/14` and taking the ratio of actual to expected:

| percentile | ratio |
|---|---|
| p50 | 0.88 |
| p90 | 1.11 |
| p95 | 1.20 |
| **p99** | **1.47** |
| max | 4.51 |

Three renders sat far outside that distribution — at **2.17×, 2.55× and 4.51×** — with nothing between them and the p99. Two were Doctor Caius, one was Evans. The worst case was Caius in II.III: 110 characters of text rendered as **39 seconds** of audio, against a ~9-second baseline.

The clustering is not random. The failures land on exactly the hardest text in the play: Caius's French-mangled English (*"By gar, den, I have as mush mock-vater as de Englishman"*), Evans's Welsh, and the Latin-declension scene (*"Nominativo, hig, hag, hog"*). Off-distribution input, off-distribution output.

Three bad renders in 1,064 is about 0.3%. Low enough to never show up in casual testing. High enough that a full rehearsal will hit one.

---

## Why it survived

Finding the cause explained the audio. It didn't explain why the audio was *still there* weeks later, and that turned out to be the more serious design lesson.

Three mechanisms compounded:

**The cache validated existence, not content.** A cache hit was an S3 `HeadObject` — does an object live at this key? Nothing ever asked whether the object was any good. Once a bad render was written, it was served forever.

**Content-derived IDs made it permanent.** The same property that makes re-imports cheap — unchanged text keeps its ID, so its audio stays valid — means re-importing the play lands on the same key and hits the same bad object. There was no operation, short of manual deletion, that would ever re-render it.

**The engine wasn't in the cache key.** The key was `{play}/{character}/{blockId}__{voiceId}.mp3`. Voice was in there, deliberately, so changing a character's voice couldn't serve stale audio. The *engine* wasn't — so switching engines would have changed nothing about anything already cached. The fix for the bug would have silently failed to fix the bug.

And underneath all three: the artifact was correct in every respect a program could check. Valid MP3. Right voice. Right key. Right length to be plausible. **The only signal that anything was wrong was a human listening to it.**

---

## The solution

Four changes, in the order they matter.

### 1. Neural instead of generative

The expressiveness of generative isn't worth non-deterministic output in a memorization tool, where the whole point is learning cues by ear. Neural is also *cheaper* — $16 per million characters against generative's $30, with a 1M-character monthly free tier where generative gives 100K. The premium was buying the defect.

### 2. The engine goes in the cache key

```
{play}/{character}/{blockId}__{voiceId}__{engine}.mp3
```

Now a change of engine is a change of key. The old renders become unreachable rather than silently authoritative, and two engines can coexist without collision.

### 3. A duration guard before the write

The failure mode is audio that passes every structural check and is simply too long, so the guard measures the one thing that betrays it:

```ts
const expected = 0.8 + text.length / 14;   // seconds
if (duration > expected * 1.75) throw new PollyError("IMPLAUSIBLE_AUDIO", …);
```

The 1.75× threshold is calibrated, not guessed: it sits in the empty gap between the corpus's p99 of 1.47 and the known-bad renders at 2.17 and above. Deliberately loose — a false positive costs a block its audio, and slow delivery is not the same as wrong delivery.

It **throws rather than retries**, which is the right call for a deterministic engine: an identical request returns identical bytes, so a retry would re-fetch the same bad audio and bill for it. The caller already degrades to a text-only prompt.

Measuring duration needs no decoder and no dependency — the MP3 frame header carries the bitrate, and Polly's output is constant bitrate, so it's `bytes / rate` after a four-byte parse.

### 4. Adaptive retry

Not part of the original bug, but discovered immediately: neural's `SynthesizeSpeech` quota is far below generative's, and the first re-warm lost **254 of 1,064 blocks** to `ThrottlingException`. The SDK's default fixed backoff retries into the same wall. `retryMode: "adaptive"` measures the throttling it receives and paces itself accordingly; with `maxAttempts: 8` the second pass completed with zero failures.

This matters beyond bulk warming — the live endpoint synthesizes on a cache miss too.

---

## Results

Cache purged and fully re-warmed on neural: **1,064 blocks, zero failures, zero renders rejected by the new guard** — no false positives on the threshold.

| block | before | after |
|---|---|---|
| Evans I.I #8 | 127,484 B / 21.2s | **53,900 B / 9.0s** |
| Caius II.III #43 | 234,476 B / 39.1s | **65,132 B / 10.9s** |

Both match the standalone neural renders byte for byte, and production serves them from cache.

Total cost of re-rendering the entire play: ~109,000 characters, **$1.75** at list price, and free inside the neural tier.

---

## What I'd take away from this

**"Hallucination" is not exclusively a text-generation problem.** Any autoregressive model can fail to stop, and speech synthesis is now an autoregressive model. The failure looks nothing like a crash — it looks like a slightly long audio file.

**Content-addressed caching is only as good as what you put in the address.** The key hashed everything about *what* was being said and nothing about *how* it was produced. That gap was invisible right up until it mattered, and it would have silently defeated the fix.

**An existence check is not a validity check.** `HeadObject` returning 200 means bytes are present. Treating that as "the cache is correct" is a decision, and it's worth making it deliberately rather than by default — especially where nothing downstream will ever re-derive the value.

**Determinism is a feature you can test for.** "Same input, same bytes" is a property you can assert in a few lines. Non-determinism in a cached artifact means the cache is recording one sample from a distribution, permanently.

**Some defects are only detectable physically.** No type, schema, or status code would have caught this. The check that works is a measurement — does this artifact's *size* match what its input can account for — and that check only became obvious after listening to it.
