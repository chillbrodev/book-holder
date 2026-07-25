import { assertEquals } from "@std/assert";
import { app } from "../app.ts";

Deno.test("GET / returns a welcome message", async () => {
  const res = await app.request("/");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.message, "The Book Holder API");
});

Deno.test("GET /health returns ok", async () => {
  const res = await app.request("/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
});
