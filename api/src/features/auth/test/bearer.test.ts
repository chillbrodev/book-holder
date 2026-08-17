// Header parsing, on its own. Small, but it is the seam every authenticated
// request passes through, and each of these cases has a wrong-but-plausible
// implementation that fails only for real clients: splitting on " " and taking
// [1] (fine until a header is double-spaced), matching "Bearer " case-
// sensitively (fine until a client sends "bearer"), or returning "" instead of
// undefined for a blank value, which downstream reads as "a token was sent".
import { assertEquals } from "@std/assert";
import { bearerToken, socketToken } from "../bearer.ts";

Deno.test("bearerToken reads the token out of an Authorization header", () => {
  assertEquals(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
});

Deno.test("bearerToken accepts any casing of the scheme", () => {
  assertEquals(bearerToken("bearer abc.def.ghi"), "abc.def.ghi");
  assertEquals(bearerToken("BEARER abc.def.ghi"), "abc.def.ghi");
});

Deno.test("bearerToken tolerates extra whitespace", () => {
  assertEquals(bearerToken("  Bearer   abc.def.ghi  "), "abc.def.ghi");
});

Deno.test("bearerToken returns undefined for anything that isn't a bearer token", () => {
  // Each of these must read as "guest", never as an empty-string token.
  assertEquals(bearerToken(undefined), undefined);
  assertEquals(bearerToken(""), undefined);
  assertEquals(bearerToken("Bearer"), undefined);
  assertEquals(bearerToken("Bearer   "), undefined);
  assertEquals(bearerToken("Basic dXNlcjpwYXNz"), undefined);
});

Deno.test("socketToken reads the token out of an offered subprotocol list", () => {
  assertEquals(socketToken("bearer, abc.def.ghi"), "abc.def.ghi");
  // Browsers are not required to insert the space after the comma.
  assertEquals(socketToken("bearer,abc.def.ghi"), "abc.def.ghi");
});

Deno.test("socketToken ignores a handshake that isn't offering auth", () => {
  // A guest's socket must still open, so none of these may throw or produce a
  // token; they simply mean nobody is signed in.
  assertEquals(socketToken(undefined), undefined);
  assertEquals(socketToken(""), undefined);
  assertEquals(socketToken("bearer"), undefined);
  assertEquals(socketToken("graphql-ws, abc.def.ghi"), undefined);
});
