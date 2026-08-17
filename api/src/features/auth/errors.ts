import { BaseError } from "../../errors/base-error.ts";

// One case, deliberately. Registration, password checking and lockout all live
// in Supabase now, so the only thing this API can say about a credential is
// whether the token it was handed verifies. Expired, forged, wrong project and
// missing are all UNAUTHENTICATED: the client's response to every one of them is
// to sign in again, and telling a prober which of them it was helps only them.
type AuthErrorName = "UNAUTHENTICATED";

export class AuthError extends BaseError<AuthErrorName> {
  override nameToErrorCodeLookup = new Map<AuthErrorName, number>([
    ["UNAUTHENTICATED", 401],
  ]);
}
