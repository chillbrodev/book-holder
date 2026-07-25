import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { AuthService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, ConfigClient.Auth.sessionCookieName);
  const user = await AuthService.getSessionUser(token);
  c.set("user", user);
  await next();
};
