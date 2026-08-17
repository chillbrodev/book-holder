import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: Pool | undefined;

/** Lazy, only reads COCKROACHDB_URL / opens a connection when something
 * actually calls this. Review-only and --dry-run runs never hit this at all. */
export function getPool(): Pool {
  if (!pool) {
    // Explicit path, not "dotenv/config", CWD isn't reliable since this can
    // run via `npm run import:play --workspace=...`, which chdirs into the
    // workspace directory rather than staying at the repo root.
    //
    // `api/.env` rather than a root one, and this is deliberate rather than a
    // leftover: there is no repo-root .env any more (each runtime owns its
    // own), and COCKROACHDB_URL has to live in exactly one file or the
    // importer, the migrator and the API drift onto different clusters — which
    // fails as data written where nobody is looking for it, not as an error.
    // The API owns the database connection, so its file is the one.
    config({ path: resolve(__dirname, "../../../api/.env") });

    const connectionString = process.env.COCKROACHDB_URL;
    if (!connectionString) {
      throw new Error("COCKROACHDB_URL is not set. Copy api/.env.example to api/.env and fill it in.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
