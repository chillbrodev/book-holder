import { BaseError } from "../../errors/base-error.ts";

type AuthErrorName =
  | "VALIDATION_ERROR"
  | "INVALID_CREDENTIALS"
  | "UNAUTHENTICATED"
  | "ACCOUNT_LOCKED"
  | "USERNAME_TAKEN";

export class AuthError extends BaseError<AuthErrorName> {
  override nameToErrorCodeLookup = new Map<AuthErrorName, number>([
    ["VALIDATION_ERROR", 400],
    ["INVALID_CREDENTIALS", 401],
    ["UNAUTHENTICATED", 401],
    ["ACCOUNT_LOCKED", 423],
    ["USERNAME_TAKEN", 409],
  ]);
}
