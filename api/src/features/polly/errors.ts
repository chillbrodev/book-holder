import { BaseError } from "../../errors/base-error.ts";

type PollyErrorName =
  | "VALIDATION_ERROR"
  | "LINE_NOT_FOUND"
  | "VOICE_UNAVAILABLE"
  | "IMPLAUSIBLE_AUDIO";

export class PollyError extends BaseError<PollyErrorName> {
  override nameToErrorCodeLookup = new Map<PollyErrorName, number>([
    ["VALIDATION_ERROR", 400],
    ["LINE_NOT_FOUND", 404],
    ["VOICE_UNAVAILABLE", 503],
    // Same 503 as VOICE_UNAVAILABLE on purpose: to a client these are the
    // same situation: no audio for this block, fall back to a text-only
    // prompt (BE_PLAN.md §5). The distinct name is for the server logs and
    // the warm run, which do need to tell "Polly was down" apart from
    // "Polly answered with something wrong".
    ["IMPLAUSIBLE_AUDIO", 503],
  ]);
}
