import type { AuthUser } from "./features/auth/interfaces.ts";

/** Hono generics: what `c.get("user")`/`c.set("user", ...)` are typed as.
 * Shared across features (any protected route in any feature reads the
 * same session user), so it lives here rather than inside features/auth. */
export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};
