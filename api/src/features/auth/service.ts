import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { hashPin, isValidPinFormat, verifyPin } from "./pin.ts";
import { generateSessionToken, hashSessionToken } from "./session-tokens.ts";
import { AuthError } from "./errors.ts";
import type { AuthUser } from "./interfaces.ts";

// Account lockout: after this many wrong PINs in a row, the account is
// locked for LOCKOUT_MINUTES rather than allowed to keep guessing — PINs
// are low-entropy (4-8 digits), so online rate-limiting matters as much as
// the offline hashing cost in pin.ts.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export type IssuedSession = {
  user: AuthUser;
  token: string;
  expiresAt: Date;
};

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres/CockroachDB unique_violation SQLSTATE.
  return typeof err === "object" && err !== null &&
    (err as { code?: string }).code === "23505";
}

export const AuthService = {
  async register(
    input: { username?: string; name?: string; pin?: string },
  ): Promise<IssuedSession> {
    const { username, name, pin } = input;
    if (!username?.trim() || !name?.trim() || !pin) {
      throw new AuthError(
        "VALIDATION_ERROR",
        "username, name, and pin are all required.",
      );
    }
    if (!isValidPinFormat(pin)) {
      throw new AuthError("VALIDATION_ERROR", "PIN must be 4-8 digits.");
    }

    const normalizedUsername = normalizeUsername(username);
    const pinHash = await hashPin(pin);

    let userId: string;
    try {
      const result = await DbClient.getPool().query(
        "INSERT INTO users (name, username, pin_hash) VALUES ($1, $2, $3) RETURNING id",
        [name.trim(), normalizedUsername, pinHash],
      );
      userId = result.rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AuthError(
          "USERNAME_TAKEN",
          "That username is already in use.",
          { cause: err },
        );
      }
      throw err;
    }

    return AuthService.issueSession(userId, {
      id: userId,
      username: normalizedUsername,
      name: name.trim(),
    });
  },

  async login(
    input: { username?: string; pin?: string },
  ): Promise<IssuedSession> {
    const { username, pin } = input;
    if (!username?.trim() || !pin) {
      throw new AuthError("VALIDATION_ERROR", "username and pin are required.");
    }

    const pool = DbClient.getPool();
    const normalizedUsername = normalizeUsername(username);
    const result = await pool.query(
      `SELECT id, name, username, pin_hash, failed_pin_attempts, locked_until
       FROM users WHERE username = $1`,
      [normalizedUsername],
    );

    if (result.rows.length === 0) {
      throw new AuthError("INVALID_CREDENTIALS", "Invalid username or PIN.");
    }
    const user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const retryAfterSeconds = Math.ceil(
        (new Date(user.locked_until).getTime() - Date.now()) / 1000,
      );
      throw new AuthError(
        "ACCOUNT_LOCKED",
        `Too many failed attempts. Try again in ${retryAfterSeconds} seconds.`,
        { context: { retryAfterSeconds, userId: user.id } },
      );
    }

    const valid = user.pin_hash ? await verifyPin(pin, user.pin_hash) : false;

    if (!valid) {
      // CockroachDB's INT is 64-bit, so `pg` returns it as a string (avoids
      // silent precision loss past Number.MAX_SAFE_INTEGER) — Number(...) it
      // explicitly, or `+ 1` silently string-concatenates instead of adding.
      const attempts = Number(user.failed_pin_attempts) + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        await pool.query(
          // $2 needs an explicit ::INT cast — without it CockroachDB infers
          // its type as INTERVAL from the multiplication context and fails
          // with "unsupported binary operator: <interval> * <interval>".
          "UPDATE users SET failed_pin_attempts = 0, locked_until = now() + ($2::INT * interval '1 minute') WHERE id = $1",
          [user.id, LOCKOUT_MINUTES],
        );
      } else {
        await pool.query(
          "UPDATE users SET failed_pin_attempts = $1 WHERE id = $2",
          [attempts, user.id],
        );
      }
      throw new AuthError("INVALID_CREDENTIALS", "Invalid username or PIN.");
    }

    await pool.query(
      "UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE id = $1",
      [user.id],
    );

    return AuthService.issueSession(user.id, {
      id: user.id,
      username: user.username,
      name: user.name,
    });
  },

  async issueSession(userId: string, user: AuthUser): Promise<IssuedSession> {
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(
      Date.now() + ConfigClient.Auth.sessionTtlDays * 24 * 60 * 60 * 1000,
    );

    await DbClient.getPool().query(
      "INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, tokenHash, expiresAt],
    );

    return { user, token, expiresAt };
  },

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = await hashSessionToken(token);
    await DbClient.getPool().query(
      "DELETE FROM auth_sessions WHERE token_hash = $1",
      [tokenHash],
    );
  },

  async getSessionUser(token: string | undefined): Promise<AuthUser> {
    if (!token) {
      throw new AuthError("UNAUTHENTICATED", "Not logged in.");
    }

    const tokenHash = await hashSessionToken(token);
    const result = await DbClient.getPool().query(
      `SELECT u.id, u.username, u.name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      throw new AuthError("UNAUTHENTICATED", "Not logged in.");
    }

    return result.rows[0];
  },
};
