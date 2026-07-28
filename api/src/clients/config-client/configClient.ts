import { loadSync } from "@std/dotenv";
import { bold, red } from "@std/fmt/colors";

// Repo root .env (one level above api/) — shared with infra/cockroachdb's
// migrate.ts and packages/play-importer, which read the same
// COCKROACHDB_URL. Resolved relative to CWD: `deno task` sets CWD to
// api/ (deno.json's directory), so "../.env" lands on the repo root both
// in local dev and inside the Docker image (WORKDIR /app mirrors api/).
// In deployed ECS, no .env file exists (see api/.dockerignore) — loadSync
// no-ops silently on a missing file, and real values come from the ECS
// task definition's environment instead.
loadSync({ envPath: "../.env", export: true });

// `KEY=` (blank, not removed) is how `.env.example` marks an unfilled var,
// and `Deno.env.get` returns "" for it, not undefined — `===undefined`/`??`
// alone would treat that as "present but empty" instead of falling through.
// Both helpers deliberately treat blank the same as missing.

function getDenoEnvValueOrThrow(envKey: string): string {
  const envValue = Deno.env.get(envKey);

  if (!envValue) {
    throw new Error(red(bold(`*** ALERT *** Missing ENV: ${envKey}`)));
  }

  return envValue;
}

function getDenoEnvValueOrDefault(envKey: string, fallback: string): string {
  return Deno.env.get(envKey) || fallback;
}

export const ConfigClient = {
  Server: {
    env: getDenoEnvValueOrDefault("DENO_ENV", "local"),
    get isDev(): boolean {
      return ["dev", "develop", "local"].includes(this.env.toLowerCase());
    },
    get isProduction(): boolean {
      return this.env.toLowerCase() === "production";
    },
    port: Number.parseInt(getDenoEnvValueOrDefault("PORT", "8000")),
  },
  CockroachDb: {
    url: getDenoEnvValueOrThrow("COCKROACHDB_URL"),
  },
  Aws: {
    // No credentials read here on purpose — the AWS SDK's default provider
    // chain resolves AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from the
    // environment locally, and the ECS task role's container credentials
    // automatically when deployed. Same client code both places.
    region: getDenoEnvValueOrThrow("AWS_REGION"),
  },
  Polly: {
    cacheBucket: getDenoEnvValueOrThrow("POLLY_CACHE_BUCKET"),
    // Per-character voice lives in characters.polly_voice_id (see
    // infra/cockroachdb/migrations/003_polly_voice_id.sql) — this is only
    // the fallback for a character with no assignment yet.
    defaultVoiceId: getDenoEnvValueOrDefault(
      "POLLY_DEFAULT_VOICE_ID",
      "Brian",
    ),
  },
  Auth: {
    sessionCookieName: "book_holder_session",
    allowedOrigin: getDenoEnvValueOrDefault(
      "ALLOWED_ORIGIN",
      "http://localhost:5173",
    ),
    sessionTtlDays: Number.parseInt(
      getDenoEnvValueOrDefault("SESSION_TTL_DAYS", "30"),
    ),
  },
};
