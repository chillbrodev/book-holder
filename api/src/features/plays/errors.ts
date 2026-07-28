import { BaseError } from "../../errors/base-error.ts";

type PlaysErrorName = "LINE_NOT_FOUND";

export class PlaysError extends BaseError<PlaysErrorName> {
  override nameToErrorCodeLookup = new Map<PlaysErrorName, number>([
    ["LINE_NOT_FOUND", 404],
  ]);
}
