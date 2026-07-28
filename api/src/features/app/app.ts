import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { baseErrorToResponse, isBaseError } from "../../errors/base-error.ts";
import authRoutes from "../auth/routes.ts";
import pollyRoutes from "../polly/routes.ts";
import type { AppEnv } from "../../types.ts";

export const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: ConfigClient.Auth.allowedOrigin,
    credentials: true,
  }),
);

app.get("/", (c) => c.json({ message: "The Book Holder API" }));
app.get(
  "/health",
  (c) => c.json({ status: "ok", time: new Date().toISOString() }),
);

app.route("/auth", authRoutes);
app.route("/polly", pollyRoutes);

app.onError((err, c) => {
  if (isBaseError(err)) {
    return baseErrorToResponse(err);
  }

  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // No error-tracking service wired up yet (see BE_PLAN.md) — plain stderr
  // for now, swap for a real logger call when one exists. skipReporting on
  // BaseError subclasses is where that logger would branch once it exists.
  console.error(err);
  return c.json({
    error: { name: "INTERNAL_SERVER_ERROR", msg: "Something went wrong." },
  }, 500);
});
