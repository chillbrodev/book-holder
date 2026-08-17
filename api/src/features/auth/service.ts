import { verifySupabaseToken } from "./supabaseJwt.ts";
import { AuthError } from "./errors.ts";
import type { AuthUser } from "./interfaces.ts";

/**
 * Who is asking.
 *
 * Almost nothing is left of what this used to be. Registration, PIN hashing,
 * lockout counting and the `auth_sessions` table all belonged to an
 * identity provider this API no longer is; Supabase owns them, and what remains
 * is the one question the rest of the codebase actually asks: given this token,
 * who is she?
 *
 * Kept as a plain exported object rather than collapsed into two loose
 * functions because the route tests swap its methods out (the same pattern
 * `DbClient` and `ConfigClient` use), and because both halves below want to
 * stay visibly the same lookup.
 */
export const AuthService = {
  /**
   * The signed-in actor, or a 401.
   *
   * What every auth-gated route wants: past this call there is a user, and
   * nothing downstream has to branch on there not being one.
   */
  getUser(token: string | undefined): Promise<AuthUser> {
    if (!token) {
      throw new AuthError("UNAUTHENTICATED", "Not signed in.");
    }
    return verifySupabaseToken(token);
  },

  /**
   * Who this token belongs to, or `null` for nobody.
   *
   * The same check as `getUser` without the throw, for the one caller that
   * needs to know who she is without requiring her to be anyone: the capture
   * socket. `coaching-plan.md` §7 makes that socket auth-aware but not
   * auth-gated — a guest gets the mic, the other parts, and the same live
   * coaching, and only the *memory* is withheld, which is exactly what "Save
   * Progress" has always been offering.
   *
   * An invalid token is deliberately treated as a guest rather than as an
   * error. Her token expiring mid-rehearsal must not close the socket and cost
   * her the speech she is in the middle of; it costs her only the writing-down.
   */
  async findUser(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      return await verifySupabaseToken(token);
    } catch {
      return null;
    }
  },
};
