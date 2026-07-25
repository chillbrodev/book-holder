import { assertEquals } from "@std/assert";
import { hashPin, isValidPinFormat, verifyPin } from "../pin.ts";

Deno.test("isValidPinFormat accepts 4-8 digit numeric PINs", () => {
  assertEquals(isValidPinFormat("1234"), true);
  assertEquals(isValidPinFormat("12345678"), true);
  assertEquals(isValidPinFormat("123"), false);
  assertEquals(isValidPinFormat("123456789"), false);
  assertEquals(isValidPinFormat("12a4"), false);
  assertEquals(isValidPinFormat(""), false);
});

Deno.test("hashPin + verifyPin round-trip", async () => {
  const encoded = await hashPin("4242");
  assertEquals(await verifyPin("4242", encoded), true);
  assertEquals(await verifyPin("0000", encoded), false);
});

Deno.test("hashPin produces a different salt (and hash) each time", async () => {
  const a = await hashPin("4242");
  const b = await hashPin("4242");
  assertEquals(a === b, false);
  assertEquals(await verifyPin("4242", a), true);
  assertEquals(await verifyPin("4242", b), true);
});

Deno.test("verifyPin rejects malformed encodings instead of throwing", async () => {
  assertEquals(await verifyPin("4242", "not-a-real-hash"), false);
  assertEquals(
    await verifyPin("4242", "pbkdf2$sha256$notanumber$aa$bb"),
    false,
  );
});
