/**
 * Turning a Supabase access token into the actor it belongs to.
 *
 * This is the whole of authentication now. There is no session table, no
 * password, and nothing to look up in CockroachDB: the browser signs in against
 * Supabase, gets an access token, and sends it on every request. A token that
 * verifies *is* the answer to "who is this".
 *
 * Verification is asymmetric. The project signs with ES256 and publishes the
 * public half of the key at `/auth/v1/.well-known/jwks.json`, so this runs
 * against a public document and needs no credential of its own — see the
 * comment on `ConfigClient.Supabase` for why that matters and why the admin
 * `sb_secret_…` key deliberately isn't wired into this service.
 *
 * `jose` rather than hand-rolled WebCrypto, and not for want of primitives:
 * Deno has all of them. It is the surrounding detail that is easy to get subtly
 * wrong and impossible to notice — picking the right key by `kid`, refusing an
 * `alg` the key wasn't issued for (the `alg: none` and HS256-signed-with-the-
 * RSA-public-key families of bug), decoding ES256's raw r||s signature rather
 * than DER, re-fetching the key set when the project rotates. A verifier that
 * is wrong in any of those ways still says "valid" for every honest token, so
 * the tests pass and the hole stays open.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { AuthError } from "./errors.ts";
import type { AuthUser } from "./interfaces.ts";

/**
 * Fetched once and cached, with rotation handled inside: a token whose `kid` is
 * not in the cached set triggers a re-fetch (rate-limited, so an attacker
 * cannot use unknown `kid`s to make us hammer Supabase). Module-level on
 * purpose — a per-request key set would be an extra network round trip on every
 * single authenticated call.
 */
const jwks = createRemoteJWKSet(new URL(ConfigClient.Supabase.jwksUrl));

/** The claims this API reads. Supabase sends considerably more; anything not
 * named here is deliberately ignored rather than trusted. */
interface SupabaseClaims {
  sub?: string;
  email?: string;
  user_metadata?: { name?: string; full_name?: string };
}

/**
 * What to call her.
 *
 * Supabase email sign-up has no required display name, so `user_metadata.name`
 * is whatever the sign-up form chose to put there and is frequently absent. The
 * local part of the email address is a better fallback than the whole address:
 * the header greets her by it ("Hi, …"), and an email address in that slot
 * reads as a system message rather than a greeting.
 */
function displayName(claims: SupabaseClaims): string {
  const fromMetadata = claims.user_metadata?.name?.trim() ||
    claims.user_metadata?.full_name?.trim();
  if (fromMetadata) return fromMetadata;

  const localPart = claims.email?.split("@")[0]?.trim();
  return localPart || "Actor";
}

/**
 * Verify a Supabase access token, or throw `UNAUTHENTICATED`.
 *
 * Every failure collapses to one error on purpose. Expired, forged, issued by
 * another project, signed with a key we've never seen — the client can do
 * exactly one thing about any of them (sign in again), and distinguishing them
 * in the response only tells someone probing the endpoint which part of their
 * token was wrong.
 *
 * `audience: "authenticated"` is Supabase's role claim for a signed-in user and
 * is checked rather than assumed, because it is what separates a user token
 * from the other things the same key signs.
 */
export async function verifySupabaseToken(token: string): Promise<AuthUser> {
  let claims: SupabaseClaims;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ConfigClient.Supabase.issuer,
      audience: "authenticated",
      // An allow-list rather than "whatever the header says", which is the
      // classic JWT hole: `alg: none`, or an HS256 token signed with the
      // public key the JWKS hands out for free. Both asymmetric families are
      // listed, not just the ES256 this project currently signs with, so
      // rotating the signing key to RSA is an operation in Supabase rather
      // than a deploy here. Nothing symmetric is ever accepted.
      algorithms: ["ES256", "RS256"],
    });
    claims = payload as SupabaseClaims;
  } catch (err) {
    throw new AuthError(
      "UNAUTHENTICATED",
      "That sign-in has expired. Sign in again to keep saving your progress.",
      { cause: err },
    );
  }

  // `sub` is the Supabase user id, and it is what every `user_id` column in
  // CockroachDB now holds. A verified token without one would mean the whole
  // ownership model has nothing to key on, so it is refused rather than
  // defaulted — a blank owner would silently pool several actors' history into
  // one row.
  if (!claims.sub) {
    throw new AuthError(
      "UNAUTHENTICATED",
      "That sign-in is missing a user id.",
    );
  }

  return {
    id: claims.sub,
    email: claims.email ?? "",
    name: displayName(claims),
  };
}
