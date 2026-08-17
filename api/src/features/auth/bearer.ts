/**
 * Pulling the access token off the wire.
 *
 * Two shapes, because the browser gives us two very different envelopes.
 *
 * This is the part that replaced the cookie, and the reason the change was
 * worth making: the frontend (Amplify) and this API (ECS) are on unrelated
 * domains, so a session cookie between them had to be `SameSite=None; Secure`
 * and was therefore at the mercy of every browser's third-party-cookie policy —
 * Safari's ITP blocks it outright. An `Authorization` header is not a cookie,
 * carries no origin rules, and works identically on every browser and from
 * curl.
 */

/**
 * `Authorization: Bearer <token>` → `<token>`.
 *
 * Case-insensitive on the scheme because RFC 7235 says the scheme is, and
 * clients do vary. Returns undefined rather than throwing for anything else:
 * "no token" is the normal state of a guest, not an error, and only the callers
 * that require a user get to decide it is one.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * The same token, arriving on a WebSocket handshake.
 *
 * A browser `WebSocket` cannot set request headers — there is no options bag
 * for it in the API, by design — so `Authorization` is simply not available on
 * the capture socket. The two ways out are a query parameter or the
 * `Sec-WebSocket-Protocol` header, and this takes the second: a query string is
 * written to ALB access logs, ECS task logs and anything else that records a
 * URL, which turns every rehearsal into a logged credential. The subprotocol
 * header is not logged as part of the URL.
 *
 * The client offers two protocols, `["bearer", "<token>"]`, which arrives here
 * as `Sec-WebSocket-Protocol: bearer, <token>`. The "bearer" sentinel is what
 * the server echoes back in its acceptance — RFC 6455 requires the server to
 * select one of the offered protocols, and echoing the token itself would put
 * the credential in a *response* header for no reason.
 *
 * Safe as a protocol token: a JWT is base64url plus dots, and `A-Za-z0-9-_.`
 * are all valid RFC 7230 token characters, so nothing needs escaping.
 */
export function socketToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const offered = header.split(",").map((part) => part.trim());
  if (offered[0]?.toLowerCase() !== "bearer") return undefined;
  return offered[1] || undefined;
}

/** What the server must echo when it accepted a `socketToken` handshake.
 * Exported so the client's sentinel and the server's answer are one constant
 * rather than two string literals that can drift. */
export const SOCKET_AUTH_PROTOCOL = "bearer";
