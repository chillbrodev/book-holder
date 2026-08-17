/**
 * The verifier, against real signatures.
 *
 * A locally generated ES256 key pair stands in for the project's signing key,
 * and `fetch` is stubbed so the module's remote JWKS resolves to the matching
 * public key. Real `jose`, real crypto, real tokens — the only fake is where
 * the key set comes from.
 *
 * Worth the setup because the failure mode this guards against is silent: a
 * verifier that accepts every honest token but also accepts a forged one, an
 * expired one, or one minted by a different Supabase project passes any test
 * that only checks the happy path. Each case below is a token that must be
 * *refused*, and each corresponds to a real way of getting this wrong.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ConfigClient } from "../../../clients/config-client/configClient.ts";
import { AuthError } from "../errors.ts";

const ISSUER = ConfigClient.Supabase.issuer;
const KID = "test-signing-key";

const { publicKey, privateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
// A second, unrelated key: this is the forger. Its public half is never
// published, so a token signed with it must fail no matter how correct its
// claims look.
const other = await generateKeyPair("ES256", { extractable: true });

const jwks = {
  keys: [{
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: "ES256",
    use: "sig",
  }],
};

// Installed before the first import-time-created key set is ever used; jose
// fetches lazily, on the first verification, so this lands in time.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: URL | RequestInfo) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === ConfigClient.Supabase.jwksUrl) {
    return Promise.resolve(
      new Response(JSON.stringify(jwks), {
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return realFetch(input as RequestInfo);
}) as typeof fetch;

// Imported after the stub is in place. The module builds its remote key set at
// import time, and while that construction does not itself fetch, keeping the
// order explicit means this test does not depend on that staying true.
const { verifySupabaseToken } = await import("../supabaseJwt.ts");

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  key?: CryptoKey;
  claims?: Record<string, unknown>;
}

function mint(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({
    email: "beatrice@example.com",
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? "authenticated")
    .setSubject("6f1d2a54-0000-4000-8000-000000000001")
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "1h")
    .sign(overrides.key ?? privateKey);
}

function assertRefused(token: Promise<string>) {
  return assertRejects(
    async () => await verifySupabaseToken(await token),
    AuthError,
  );
}

Deno.test("a valid token resolves to the actor it names", async () => {
  const user = await verifySupabaseToken(await mint());
  assertEquals(user.id, "6f1d2a54-0000-4000-8000-000000000001");
  assertEquals(user.email, "beatrice@example.com");
});

Deno.test("the display name prefers user_metadata over the email", async () => {
  const user = await verifySupabaseToken(
    await mint({ claims: { user_metadata: { name: "Beatrice" } } }),
  );
  assertEquals(user.name, "Beatrice");
});

Deno.test("without a name, the email's local part is the greeting", async () => {
  // The header renders this as "Hi, …", where a full email address reads as a
  // system message rather than as being spoken to.
  const user = await verifySupabaseToken(await mint());
  assertEquals(user.name, "beatrice");
});

Deno.test("a token signed by another key is refused", async () => {
  await assertRefused(mint({ key: other.privateKey }));
});

Deno.test("a token from another Supabase project is refused", async () => {
  // The signature would still be checked against *our* JWKS here, but the
  // issuer check is what makes this fail for the right reason, and it is the
  // one that matters if a key is ever shared across projects.
  await assertRefused(
    mint({ issuer: "https://someone-else.supabase.co/auth/v1" }),
  );
});

Deno.test("a token for a different audience is refused", async () => {
  await assertRefused(mint({ audience: "anon" }));
});

Deno.test("an expired token is refused", async () => {
  await assertRefused(mint({ expiresIn: "-1m" }));
});

Deno.test("a verified token with no subject is refused", async () => {
  // Not paranoia: `sub` is what every user_id column in CockroachDB holds, so a
  // token without one has no owner to write rows against.
  const token = await new SignJWT({ email: "beatrice@example.com" })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  await assertRejects(() => verifySupabaseToken(token), AuthError);
});

Deno.test("garbage is refused rather than thrown raw", async () => {
  // The point is the error *type*: a raw jose error would reach app.ts's
  // onError as an unknown and come back a 500, which tells a client with a
  // stale token to retry rather than to sign in again.
  const err = await assertRejects(
    () => verifySupabaseToken("not-a-jwt"),
    AuthError,
  );
  assertEquals(err.statusCode, 401);
});
