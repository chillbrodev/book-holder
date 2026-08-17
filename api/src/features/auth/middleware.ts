import type { MiddlewareHandler } from "hono";
import { bearerToken } from "./bearer.ts";
import { AuthService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

/**
 * Requires a valid Supabase access token and puts the actor on the context.
 *
 * Reads the `Authorization` header rather than a cookie. That is the entire
 * point of the move to Supabase: the frontend and this API live on different
 * domains, and a cross-site session cookie is a third-party cookie — blocked
 * outright by Safari's ITP, and increasingly by everything else. A bearer token
 * has no origin rules to fall foul of. See `bearer.ts`.
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await AuthService.getUser(
    bearerToken(c.req.header("authorization")),
  );
  c.set("user", user);
  await next();
};
