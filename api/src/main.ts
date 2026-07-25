export function handler(req: Request): Response {
  const url = new URL(req.url);

  if (url.pathname === "/api") {
    return Response.json({
      message: "Hello, world!",
      time: new Date().toISOString(),
    });
  }

  return new Response("<h1>Welcome to Deno!</h1>", {
    headers: { "content-type": "text/html" },
  });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8000);
  Deno.serve({ port }, handler);
}
