// How long an MP3 actually plays for, read off its frame header.
//
// Exists to answer one question: does this render's length match the text it
// was supposed to be? A text-to-speech engine that invents extra sentences
// produces audio that is correct in every respect a type system can check —
// valid MP3, right voice, right key — and simply too long. Duration is the
// only signal that separates it from a good render.
//
// Pure and dependency-free on purpose: no decoder, no ffprobe, no temp file.
// The frame header carries the bitrate, and Polly's MP3 output is constant
// bitrate, so the whole calculation is size / rate.

/** Layer III bitrates in kbps, indexed by the header's 4-bit bitrate field.
 * Index 0 is "free format" and 15 is invalid; both are rejected below. */
const BITRATES_MPEG1 = [
  0,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  160,
  192,
  224,
  256,
  320,
];
const BITRATES_MPEG2 = [
  0,
  8,
  16,
  24,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  144,
  160,
];

/** Bytes to scan for a frame sync before giving up. A Polly response starts
 * with one immediately; this only has to tolerate a short tag. */
const MAX_SYNC_SCAN_BYTES = 8192;

/** Skips an ID3v2 tag, whose size is stored as four 7-bit big-endian bytes.
 * Polly doesn't emit one, but a hand-supplied fixture might. */
function audioStart(audio: Uint8Array): number {
  const hasId3 = audio.length >= 10 &&
    audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  if (!hasId3) return 0;

  const size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) |
    ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
  return 10 + size;
}

/**
 * Playing time in seconds, or `undefined` if this isn't MP3 we can measure.
 *
 * Undefined rather than a throw or a zero: the caller uses this to *reject*
 * bad audio, and a parse failure is not evidence of bad audio. Failing to read
 * a header must not block an otherwise fine render from being cached.
 *
 * Assumes constant bitrate, which is what Polly returns (MPEG-2 Layer III,
 * 48 kbps, 24 kHz as of this writing). A VBR file would report the first
 * frame's rate and come out wrong — acceptable, because nothing here produces
 * one, and the caller's threshold is a loose sanity bound, not a measurement.
 */
export function mp3DurationSeconds(audio: Uint8Array): number | undefined {
  const start = audioStart(audio);
  if (start >= audio.length - 4) return undefined;

  const limit = Math.min(audio.length - 4, start + MAX_SYNC_SCAN_BYTES);
  for (let i = start; i <= limit; i++) {
    if (audio[i] !== 0xff || (audio[i + 1] & 0xe0) !== 0xe0) continue;

    const versionBits = (audio[i + 1] >> 3) & 0x03;
    const layerBits = (audio[i + 1] >> 1) & 0x03;
    // 0b01 is a reserved version, 0b01 in the layer field is Layer III —
    // anything else here is a false sync or audio we don't handle.
    if (versionBits === 0x01 || layerBits !== 0x01) continue;

    const bitrateIndex = (audio[i + 2] >> 4) & 0x0f;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f) continue;

    // 0b11 is MPEG-1; 0b10 (MPEG-2) and 0b00 (MPEG-2.5) share a table.
    const kbps = versionBits === 0x03
      ? BITRATES_MPEG1[bitrateIndex]
      : BITRATES_MPEG2[bitrateIndex];

    return ((audio.length - start) * 8) / (kbps * 1000);
  }

  return undefined;
}
