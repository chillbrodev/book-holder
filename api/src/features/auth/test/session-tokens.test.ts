import { assertEquals } from "@std/assert";
import { generateSessionToken, hashSessionToken } from "../session-tokens.ts";

Deno.test("generateSessionToken produces unique url-safe tokens", () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assertEquals(a === b, false);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true);
});

Deno.test("hashSessionToken is deterministic and does not return the raw token", async () => {
  const token = generateSessionToken();
  const hashA = await hashSessionToken(token);
  const hashB = await hashSessionToken(token);
  assertEquals(hashA, hashB);
  assertEquals(hashA === token, false);
});
