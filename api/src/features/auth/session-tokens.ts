const TOKEN_LENGTH_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The raw token handed to the client (cookie value), never stored as-is. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH_BYTES));
  return encodeBase64Url(bytes);
}

/** What actually lands in auth_sessions.token_hash, so a leaked/dumped
 * table alone can't be replayed as a live session cookie. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return encodeBase64Url(new Uint8Array(digest));
}
