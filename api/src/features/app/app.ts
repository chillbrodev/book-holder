import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { baseErrorToResponse, isBaseError } from "../../errors/base-error.ts";
import authRoutes from "../auth/routes.ts";
import captureRoutes from "../capture/routes.ts";
import pollyRoutes from "../polly/routes.ts";
import playsRoutes from "../plays/routes.ts";
import sessionRoutes from "../sessions/routes.ts";
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
  // `version` is the deploying commit, injected as APP_VERSION by
  // ecs-deploy.sh and the deploy workflow. Without it a deploy check can only
  // ask "is something answering", which the *previous* revision also does
  // happily while a rollout is still in progress, so CI would call a deploy
  // green before the new code was serving any traffic. "dev" locally, where
  // nothing sets it.
  "/health",
  (c) =>
    c.json({
      status: "ok",
      time: new Date().toISOString(),
      version: Deno.env.get("APP_VERSION") ?? "dev",
    }),
);

app.route("/auth", authRoutes);
app.route("/capture", captureRoutes);
app.route("/polly", pollyRoutes);
app.route("/plays", playsRoutes);
app.route("/sessions", sessionRoutes);

app.onError((err, c) => {
  if (isBaseError(err)) {
    return baseErrorToResponse(err);
  }

  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // No error-tracking service wired up yet (see BE_PLAN.md), plain stderr
  // for now, swap for a real logger call when one exists. skipReporting on
  // BaseError subclasses is where that logger would branch once it exists.
  console.error(err);
  return c.json({
    error: { name: "INTERNAL_SERVER_ERROR", msg: "Something went wrong." },
  }, 500);
});
