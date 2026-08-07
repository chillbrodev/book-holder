import { BaseError } from "../../errors/base-error.ts";

type SessionErrorName =
  | "VALIDATION_ERROR"
  | "SCENE_NOT_FOUND"
  | "SAVE_FAILED";

export class SessionError extends BaseError<SessionErrorName> {
  override nameToErrorCodeLookup: Map<SessionErrorName, number> = new Map([
    ["VALIDATION_ERROR", 400],
    ["SCENE_NOT_FOUND", 404],
    // The transaction exhausted its retries. 503 rather than 500: it is a
    // "try again" condition, not a bug in the request, and the client can
    // reasonably resubmit the same body.
    ["SAVE_FAILED", 503],
  ]);
}
