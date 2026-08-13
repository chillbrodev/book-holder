// PIN hashing via Web Crypto's PBKDF2 (native, no npm dependency, no
// node-gyp/native-binding step to complicate the Dockerfile, unlike
// bcrypt). A PIN is low-entropy by design, so the iteration count matters
// more here than it would for a real password: 600k is OWASP's 2023
// minimum recommendation for PBKDF2-HMAC-SHA256.
const HASH = "SHA-256";
const ITERATIONS = 600_000;
const KEY_LENGTH_BITS = 256;
const SALT_LENGTH_BYTES = 16;

const PIN_PATTERN = /^\d{4,8}$/;

export function isValidPinFormat(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

async function derive(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: HASH },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Encodes as `pbkdf2$sha256$<iterations>$<salt>$<hash>`, self-describing,
 * so `verifyPin` reads the iteration count/salt that were actually used
 * rather than assuming today's constants, letting ITERATIONS increase later
 * without invalidating existing rows or needing a migration.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const hash = await derive(pin, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPin(
  pin: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    return false;
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const salt = fromBase64(parts[3]);
  const expected = fromBase64(parts[4]);
  const actual = await derive(pin, salt, iterations);
  return timingSafeEqual(actual, expected);
}
