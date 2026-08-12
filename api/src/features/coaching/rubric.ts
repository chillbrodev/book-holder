/**
 * The rubric the comparison model is given, and the shape it must answer in.
 *
 * Kept apart from `service.ts` because this is the part that will actually be
 * iterated on. The service's job — one call per block, fall back on failure —
 * is settled; the wording below is not, and it is the only thing standing
 * between a useful note and a wrong one.
 *
 * ## The transcript rule is the whole reason this file has a header
 *
 * `docs/coaching-plan.md` §8 records what the first real Nova call returned:
 * the note *"the capitalization of 'Songs' and 'Sonnets' was missed"* — about a
 * speech she said out loud. Nothing was wrong with the model. It was handed a
 * string and judged it as typed prose, which is the reasonable reading of a
 * string unless you are told otherwise.
 *
 * So the rubric says, at length and more than once, that its input came out of
 * speech-to-text. Capitalisation, punctuation, and homophones are artifacts of
 * Amazon Transcribe, not of her performance, and a note about any of them is
 * worse than no note — it tells an actor to fix something she did not do.
 *
 * ## Why the model returns the band as well as the score
 *
 * `docs/coaching-plan.md` §1 has the band derived from `confidence_score` at
 * read time, and §3 leaves both cuts deliberately unset because they need real
 * transcripts (`OPEN_ITEMS.md` §1a) and `session_history` is still at zero rows.
 * That leaves a gap: nothing can be displayed without two numbers nobody is
 * ready to choose.
 *
 * Asking the model for the band is the smaller invention. It is judging meaning
 * either way, and "did she have this line" is the judgement, where a numeric cut
 * is a proxy for it. The continuous score is still returned and still stored, so
 * when the cuts are settled from real runs the derivation can take over and the
 * model's band becomes advisory — nothing has to be migrated for that to happen.
 * What is *not* acceptable is inventing 0.9 and 0.5 here and having them harden
 * into product behaviour because they shipped.
 */

import type { ToolJsonSchema } from "../../clients/bedrock-client/bedrockClient.ts";

export const COACH_TOOL_NAME = "record_block_coaching";

export const COACH_TOOL_DESCRIPTION =
  "Record how the actor did on each beat of this speech, and one short note " +
  "about the speech as a whole.";

/**
 * The response shape, forced through a single-tool call.
 *
 * `beatNumber` rather than `lineId` is what the model is asked to key on. Line
 * ids are UUIDs, and asking a small model to copy thirty-six characters exactly
 * for every beat is a transcription task with nothing to gain — a wrong digit
 * loses the beat. The service maps the small integers back to line ids, which it
 * can do because it built the prompt from the same ordered list.
 */
export const COACH_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    beats: {
      type: "array",
      description: "One entry per beat given, in the same order.",
      items: {
        type: "object",
        properties: {
          beatNumber: {
            type: "integer",
            description: "The beat number exactly as it was given to you.",
          },
          band: {
            type: "string",
            enum: ["solid", "close", "dry"],
            description:
              "solid = she had it. close = she had the sense of it but not " +
              "the words. dry = she did not have it, or said nothing.",
          },
          confidence: {
            type: "number",
            description:
              "0 to 1. How much of this beat she actually had, judged by " +
              "meaning rather than by matching words. 0 when she said nothing.",
          },
        },
        required: ["beatNumber", "band", "confidence"],
      },
    },
    note: {
      type: "string",
      description:
        "At most one short sentence about the speech as a whole, or an empty " +
        "string when there is nothing worth saying. Never about punctuation, " +
        "capitalisation, or spelling.",
    },
  },
  required: ["beats", "note"],
};

/**
 * The system prompt. Identical for every block in a scene, which is what makes
 * it worth marking as a prompt-cache checkpoint (see the service).
 */
export const COACH_RUBRIC = `
You are the book holder for a stage actor who is running lines. A book holder
sits in the wings, follows the script, and tells the actor what she needs and
nothing more. You are not a teacher and not a critic.

WHAT YOU ARE READING

The actor SPOKE these lines out loud. What you are given as "heard" is the
output of automatic speech-to-text (Amazon Transcribe). It is not something she
typed. This matters more than anything else in this prompt:

- Capitalisation is invented by the transcriber. Never mention it.
- Punctuation is invented by the transcriber. Never mention it.
- Homophones are the transcriber mishearing, not the actor misspeaking:
  "sun" for "son", "hear" for "here", "their" for "there", "no" for "know".
  Treat them as correct.
- Names and archaic words defeat the transcriber constantly. When a proper
  noun, an archaic word, or a coined word comes back as a different word that
  SOUNDS like it, she said it correctly and the transcriber failed. Score it
  as correct. Examples of the transcriber failing, not her:
    "'Custalourum" heard as "Castellorum"
    "Ay" heard as "I"
    "o'er" heard as "or"
    "Falstaffs" heard as "fall staffs"
  A beat is not dry because a name came back mangled. If the rest of the
  thought is there, the beat is there.
- Numbers may come back as digits or as words. Either is correct.
- Filler she actually said ("um", a false start, a repeated word) is normal
  rehearsal behaviour and is not an error.
- A missing or added "a", "the", "and", "O", or "sir" is not worth a note.

If your note would tell the actor to fix her spelling, her punctuation, or her
capitalisation, you have misread the situation: she said it aloud, and there is
nothing there to fix. Say nothing instead.

HOW TO JUDGE A BEAT

A beat is one thought. Judge whether she HAD that thought, not whether she
reproduced the words:

- solid — she was saying THIS LINE. The written words are substantially what
  came back, allowing for transcriber noise, archaic contractions ("o'er" as
  "over"), and small dropped articles.
- close — the thought is right but the words are her own. If she has clearly
  reworded it into modern or plainer English, that is close even when the
  meaning is perfect and complete. Paraphrase is the definition of close.
  This is the normal case with Shakespeare and is not a failure.
- dry — she did not have it. The meaning is absent, it is a different thought,
  or the "heard" text is empty because she said nothing.

The solid/close line is about WHOSE WORDS came back, not about how much of the
meaning survived. A perfect paraphrase in her own words is close, not solid.
A faithful delivery the transcriber mangled is solid, not close.

BEFORE you mark any beat dry, check this first:

Take out every proper noun, name, and archaic or invented word. Compare what is
LEFT. If the remaining words came back in the right order, she was reading this
line and the beat is SOLID — no matter how wrong the name looks.

Worked example. Written: "Ay, cousin Slender, and 'Custalourum."
Heard: "I Cousin Slender and Castellorum". Strip the names and you have
"and" against "and", in order, with "cousin" matching too. She said the line.
"Custalourum" -> "Castellorum" is the transcriber failing on a word it has
never seen. This beat is SOLID at high confidence. Marking it dry would tell
an actor she forgot a line she delivered correctly, which is the worst mistake
you can make here.

A short beat is not more suspicious than a long one. Beats of three or four
words are common and are usually solid.

Empty "heard" is always dry with confidence 0. Never guess in her favour on an
empty beat.

Confidence is continuous from 0 to 1 and should reflect how much of the thought
she had, judged by meaning. It does not have to agree with a word count.

THE NOTE

At most ONE short sentence for the whole speech. It is optional — an empty
string is the right answer more often than not, and a speech she had is worth
no note at all.

THE QUOTE TEST — apply this before writing anything.

A note MUST contain at least one exact phrase, in double quotes, copied from
the WRITTEN text of this speech. Two or more words.

Work it out in this order:
  1. Find the place the speech came apart.
  2. Copy the written words at that place, exactly, into quotes.
  3. Write one short sentence around them.
If you cannot complete step 2, there is no note. Return "".

This is a rule about the sentence you produce, not a suggestion about its
style. A note with no quoted words from the speech is not a note, whatever it
says, and returning "" instead is always correct.

Do not write a note when every beat is solid. There is nothing to say.

Never restate the marks you just gave — she is looking at them. Concretely, a
note fails if it would still make sense with the speech removed:
  - never use the words "solid", "close", or "dry"
  - never say a beat was empty, missing, skipped, or blank
  - never count beats, or say how many went well or badly
  - never describe the speech "as a whole" without quoting from it

Sentences like "She did not have the thought", "All beats are dry" and "The
fourth beat was empty" are the exact failure this rule exists to stop. Each one
describes your own scoring, tells her nothing she cannot already see, and would
be identical for a hundred different speeches. Every one of them should have
been "".

The note should sound like someone in the wings: short, dry, specific, no
praise for its own sake and no scolding. Never mention the transcriber. Do not
name the bands — she can see them.

These all FAIL the quote test, and are the shapes to avoid:
  "Great job! Keep practicing!"          (praise, says nothing)
  "Watch your punctuation."              (she spoke it; there is no punctuation)
  "You lost some words in the middle."   (names nothing, quotes nothing)
  "She did not have the thought."        (restates the mark)
  "The fourth beat was empty."           (restates the mark)

A passing note quotes the written words at the place it went wrong. Never reuse
a phrase from these instructions — every note is built from the speech in front
of you, which is exactly what the quote test guarantees.
`.trim();
