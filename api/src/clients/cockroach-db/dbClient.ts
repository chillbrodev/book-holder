import { Pool, type PoolClient } from "pg";
import { ConfigClient } from "../config-client/configClient.ts";

let pool: Pool | undefined;

/** CockroachDB's serialization-failure SQLSTATE. The transaction did not commit
 * and re-running it is the documented remedy, not an error to report. */
const RETRYABLE_SQLSTATE = "40001";

/** Attempts before giving up. Cockroach's own guidance is a bounded retry; an
 * unbounded one turns a hot contended row into an infinite loop that also holds a
 * pool connection the whole time. */
const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 50;

export const DbClient = {
  /** Lazy singleton, only opens a connection when something actually queries. */
  getPool(): Pool {
    if (!pool) {
      pool = new Pool({ connectionString: ConfigClient.CockroachDb.url });
    }
    return pool;
  },

  /**
   * Runs `fn` inside one serializable transaction, retrying serialization
   * failures with exponential backoff.
   *
   * CockroachDB is `SERIALIZABLE` always; there is no weaker level to drop to,
   * so a transaction that conflicts with a concurrent one is aborted, not
   * blocked, and the client is expected to run it again. Code that doesn't
   * retry doesn't get slow under contention, it gets wrong: the write is simply
   * lost, and the error looks like an infrastructure blip rather than the
   * ordinary, expected event it is. `PROJECT_PLAN.md` calls this out as a
   * production-readiness signal rather than boilerplate, and `BE_PLAN.md` §3
   * asks for it explicitly on the per-session write path.
   *
   * Backoff is exponential with jitter, unlike the importer's immediate retry
   * (`packages/play-importer/src/ingest.ts`, which says so in its own comment):
   * that one is a hand-run seed import competing with nothing, whereas two
   * requests retrying in lockstep collide again on the same schedule forever.
   *
   * The callback gets a dedicated `PoolClient`, and must use it for every query,
   * reaching for `getPool()` inside would run that statement on a *different*
   * connection, outside this transaction, where it neither rolls back on failure
   * nor sees the transaction's own writes.
   */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // Best-effort: if the connection itself is the problem the ROLLBACK will
        // fail too, and that must not mask the error that actually matters.
        await client.query("ROLLBACK").catch(() => {});
        lastError = err;

        if ((err as { code?: string }).code !== RETRYABLE_SQLSTATE) throw err;

        // Full jitter. Without it, two conflicting requests back off by the same
        // amount and conflict again at the same moment.
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * backoff)
        );
        console.warn(
          `Serialization conflict, retrying transaction (attempt ${attempt}/${MAX_ATTEMPTS}).`,
        );
      } finally {
        // Always returned to the pool, on every path, a leaked connection here
        // exhausts the pool and takes the whole API down with it.
        client.release();
      }
    }

    throw lastError;
  },
};
