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

function getDenoEnvValueOrThrow(envKey: string): string {
  const envValue = Deno.env.get(envKey);

  if (envValue === undefined) {
    throw new Error(red(bold(`*** ALERT *** Missing ENV: ${envKey}`)));
  }

  return envValue;
}

function getDenoEnvValueOrDefault(envKey: string, fallback: string): string {
  return Deno.env.get(envKey) ?? fallback;
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
