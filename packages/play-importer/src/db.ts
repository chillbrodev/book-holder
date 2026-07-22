import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: Pool | undefined;

/** Lazy — only reads COCKROACHDB_URL / opens a connection when something
 * actually calls this. Review-only and --dry-run runs never hit this at all. */
export function getPool(): Pool {
  if (!pool) {
    // Explicit path, not "dotenv/config" — CWD isn't reliable since this can
    // run via `npm run import:play --workspace=...`, which chdirs into the
    // workspace directory rather than staying at the repo root.
    config({ path: resolve(__dirname, "../../../.env") });

    const connectionString = process.env.COCKROACHDB_URL;
    if (!connectionString) {
      throw new Error("COCKROACHDB_URL is not set. Copy .env.example to .env and fill it in.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
