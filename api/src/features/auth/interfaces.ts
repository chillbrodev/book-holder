/**
 * The signed-in actor, as this API knows her.
 *
 * Every field is read straight out of a verified Supabase access token; none of
 * it is stored here. `id` is Supabase's `sub`, a UUID, and it is what every
 * `user_id` column in CockroachDB holds — see migration 011 for why those
 * columns keep their UUID type but no longer reference a local table.
 */
export interface AuthUser {
  id: string;
  /** Empty only in the pathological case of a token with no email claim; email
   * is the only sign-in method enabled, so in practice it is always set. */
  email: string;
  /** What the header greets her by, derived rather than stored. */
  name: string;
}
