import { BaseError } from "../../errors/base-error.ts";

type PollyErrorName =
  | "VALIDATION_ERROR"
  | "LINE_NOT_FOUND"
  | "VOICE_UNAVAILABLE";

export class PollyError extends BaseError<PollyErrorName> {
  override nameToErrorCodeLookup = new Map<PollyErrorName, number>([
    ["VALIDATION_ERROR", 400],
    ["LINE_NOT_FOUND", 404],
    ["VOICE_UNAVAILABLE", 503],
  ]);
}
