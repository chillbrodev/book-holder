import { BaseError } from "../../errors/base-error.ts";

type CaptureErrorName =
  | "VALIDATION_ERROR"
  | "BLOCK_NOT_FOUND"
  | "UPGRADE_REQUIRED"
  | "LISTENING_UNAVAILABLE";

export class CaptureError extends BaseError<CaptureErrorName> {
  override nameToErrorCodeLookup: Map<CaptureErrorName, number> = new Map([
    ["VALIDATION_ERROR", 400],
    ["BLOCK_NOT_FOUND", 404],
    // Not a WebSocket handshake — a plain GET to a route that only speaks
    // WebSocket. 426 rather than 400 so the reason is legible in a log.
    ["UPGRADE_REQUIRED", 426],
    // Transcribe unreachable, throttled, or refusing the stream. 503 to match
    // Polly's VOICE_UNAVAILABLE: from the client's point of view these are the
    // same situation — the feature that needs an AWS service is degraded, and
    // the fallback is to let her mark the beat as said herself rather than
    // block the rehearsal (BE_PLAN.md §5).
    ["LISTENING_UNAVAILABLE", 503],
  ]);
}
