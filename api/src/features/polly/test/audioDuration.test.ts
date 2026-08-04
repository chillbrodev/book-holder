// Frame-header parsing is pure — no AWS, no database — so unlike the rest of
// the Polly paths it can be tested exhaustively here rather than verified by
// hand against a live account.
//
// Frames are built by hand rather than checked-in fixtures: the header is four
// bytes and the point of each test is which bits it sets, which a binary blob
// would hide.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { mp3DurationSeconds } from "../audioDuration.ts";

type FrameOptions = {
  /** 0b11 MPEG-1, 0b10 MPEG-2, 0b00 MPEG-2.5, 0b01 reserved/invalid. */
  version?: number;
  /** 0b01 is Layer III; anything else this module ignores. */
  layer?: number;
  bitrateIndex?: number;
};

/** A buffer whose first four bytes are a valid frame header, padded with
 * silence to `totalBytes`. Only the header is parsed, so the padding's
 * contents are irrelevant — its *length* is the input under test. */
function mp3(totalBytes: number, options: FrameOptions = {}): Uint8Array {
  const { version = 0b10, layer = 0b01, bitrateIndex = 6 } = options;
  const audio = new Uint8Array(totalBytes);
  audio[0] = 0xff;
  audio[1] = 0xe0 | (version << 3) | (layer << 1) | 1;
  audio[2] = (bitrateIndex << 4) | (0 << 2);
  audio[3] = 0;
  return audio;
}

Deno.test("reads duration from an MPEG-2 Layer III frame", () => {
  // Polly's actual output format: MPEG-2, 48 kbps => 6000 bytes/second.
  assertAlmostEquals(mp3DurationSeconds(mp3(60_000))!, 10, 0.01);
});

Deno.test("uses the MPEG-1 bitrate table for MPEG-1 audio", () => {
  // Index 6 is 80 kbps under MPEG-1 but 48 kbps under MPEG-2 — the same
  // header bits mean different rates, which is the whole reason for two
  // tables.
  assertAlmostEquals(
    mp3DurationSeconds(mp3(60_000, { version: 0b11 }))!,
    6,
    0.01,
  );
});

Deno.test("scales linearly with length at a fixed bitrate", () => {
  const short = mp3DurationSeconds(mp3(30_000))!;
  const long = mp3DurationSeconds(mp3(60_000))!;
  assertAlmostEquals(long / short, 2, 0.001);
});

Deno.test("skips an ID3v2 tag and excludes it from the duration", () => {
  const frame = mp3(60_000);
  const tagged = new Uint8Array(10 + 100 + frame.length);
  tagged[0] = 0x49; // "ID3"
  tagged[1] = 0x44;
  tagged[2] = 0x33;
  // Size is four 7-bit big-endian bytes; 100 fits in the last.
  tagged[9] = 100;
  tagged.set(frame, 10 + 100);

  // The tag's bytes are not audio, so the duration must match the bare frame.
  assertAlmostEquals(mp3DurationSeconds(tagged)!, 10, 0.01);
});

Deno.test("returns undefined rather than guessing when there is no sync", () => {
  assertEquals(mp3DurationSeconds(new Uint8Array(4096)), undefined);
});

Deno.test("returns undefined for an empty or truncated buffer", () => {
  assertEquals(mp3DurationSeconds(new Uint8Array(0)), undefined);
  assertEquals(mp3DurationSeconds(new Uint8Array([0xff, 0xf3])), undefined);
});

Deno.test("rejects free-format and invalid bitrate indices", () => {
  // Index 0 is "free format" (rate not in the header) and 15 is invalid;
  // treating either as a real rate would divide by zero or by nonsense.
  assertEquals(mp3DurationSeconds(mp3(60_000, { bitrateIndex: 0 })), undefined);
  assertEquals(
    mp3DurationSeconds(mp3(60_000, { bitrateIndex: 15 })),
    undefined,
  );
});

Deno.test("ignores a reserved version and non-Layer-III audio", () => {
  assertEquals(mp3DurationSeconds(mp3(60_000, { version: 0b01 })), undefined);
  assertEquals(mp3DurationSeconds(mp3(60_000, { layer: 0b10 })), undefined);
});

Deno.test("finds a frame that does not start at byte zero", () => {
  const frame = mp3(60_000);
  const padded = new Uint8Array(64 + frame.length);
  padded.set(frame, 64);
  assertAlmostEquals(mp3DurationSeconds(padded)!, 10.008, 0.01);
});
