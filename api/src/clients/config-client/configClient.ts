import { loadSync } from "@std/dotenv";
import { bold, red } from "@std/fmt/colors";

// Repo root.env (one level above api/), shared with infra/cockroachdb's
// migrate.ts and packages/play-importer, which read the same
// COCKROACHDB_URL. Resolved relative to CWD: `deno task` sets CWD to
// api/ (deno.json's directory), so "../.env" lands on the repo root in
// local dev.
//
// Skipped entirely in production, ECS injects the task definition's
// environment variables directly into the process before the container's
// CMD even runs, so there's no .env file to load there (see
// api/.dockerignore) and no reason to grant read-file permission to attempt
// one. Deno's permission check happens before the file-existence check, so
// the "production" deno task deliberately doesn't grant
// --allow-read=../.env, attempting loadSync unconditionally would throw
// PermissionDenied on every boot instead of the graceful no-op a missing
// file would otherwise get.
if (Deno.env.get("DENO_ENV") !== "production") {
  loadSync({ envPath: "../.env", export: true });
}

// `KEY=` (blank, not removed) is how `.env.example` marks an unfilled var,
// and `Deno.env.get` returns "" for it, not undefined, `===undefined`/`??`
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
    // No credentials read here on purpose, the AWS SDK's default provider
    // chain resolves AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from the
    // environment locally, and the ECS task role's container credentials
    // automatically when deployed. Same client code both places.
    region: getDenoEnvValueOrThrow("AWS_REGION"),
  },
  Polly: {
    cacheBucket: getDenoEnvValueOrThrow("POLLY_CACHE_BUCKET"),
    // Per-character voice lives in characters.polly_voice_id (see
    // infra/cockroachdb/migrations/003_polly_voice_id.sql); this is only
    // the fallback for a character with no assignment yet.
    defaultVoiceId: getDenoEnvValueOrDefault(
      "POLLY_DEFAULT_VOICE_ID",
      "Brian",
    ),
  },
  Bedrock: {
    // Nova Micro, reached through the US geo inference profile, the `us.`
    // prefix is load-bearing, not decoration.
    //
    // Nova Micro is not available in-region in us-west-2 (AWS's model card
    // lists us-west-2 as In-Region ✗ / Geo ✓), which is the region everything
    // else here runs in. The bare `amazon.nova-micro-v1:0` therefore fails from
    // us-west-2 with a validation error that reads like a bad model id rather
    // than a regional gap. The geo profile routes the call across
    // us-east-1/us-east-2/us-west-2 and is the only way to invoke this model
    // from here.
    //
    // Consequence for IAM: invoking through a profile needs bedrock:InvokeModel
    // on the inference-profile ARN *and* on the foundation-model ARN in every
    // destination region. See infra/aws/create-dev-user.sh.
    //
    // Text-only Micro rather than multimodal Lite because a comparison is a
    // transcript against a beat's text; there is no image in this call, and
    // Micro is the faster of the two, which is what the per-beat call is
    // starved for.
    comparisonModelId: getDenoEnvValueOrDefault(
      "BEDROCK_MODEL_ID_COMPARISON",
      "us.amazon.nova-micro-v1:0",
    ),
    // Titan Text Embeddings V2. No `us.` prefix, and that is not an
    // oversight; it is the opposite case to Nova Micro above, and the two
    // are easy to pattern-match onto each other wrongly.
    //
    // Nova Micro has no in-region presence in us-west-2 and is reachable only
    // through the geo inference profile, so it needs the prefix. Titan V2 *is*
    // available in-region, has no inference profile, and the bare id is the
    // only thing that resolves, prefixing it fails with the same
    // bad-model-id-shaped error that omitting the prefix causes for Nova.
    //
    // 1024 dimensions, matching `VECTOR(1024)` from migration 004. Chosen in
    // `docs/OPEN_ITEMS.md` §2 partly because it is already a Bedrock model, so
    // embeddings add no new vendor, no new credential, and no new IAM shape
    // beyond the foundation-model ARN.
    embeddingModelId: getDenoEnvValueOrDefault(
      "BEDROCK_MODEL_ID_EMBEDDING",
      "amazon.titan-embed-text-v2:0",
    ),
    // Nova Lite for the coach agent, and the `us.` prefix for the same
    // reason Micro carries one; it is reached through the US geo inference
    // profile, not in-region.
    //
    // A step up from Micro deliberately. The comparison call is one block
    // against a rubric and Micro does it in ~800ms; the agent has to plan over
    // several tools, decide which of her weaknesses is worth naming, and write
    // one sentence a person would say. Micro is not reliable at the first of
    // those, the same limitation that made it restate the marks rather than
    // read the speech (`groundedNote` in features/coaching).
    //
    // Same family, so the IAM shape is a copy of Nova Micro's rather than a new
    // one to get wrong: profile ARN plus the foundation model in each
    // destination region, in both create-dev-user.sh and
    // task-role-policy.sh.
    agentModelId: getDenoEnvValueOrDefault(
      "BEDROCK_MODEL_ID_AGENT",
      "us.amazon.nova-lite-v1:0",
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
