import { Pool } from "pg";
import { ConfigClient } from "../config-client/configClient.ts";

let pool: Pool | undefined;

export const DbClient = {
  /** Lazy singleton — only opens a connection when something actually queries. */
  getPool(): Pool {
    if (!pool) {
      pool = new Pool({ connectionString: ConfigClient.CockroachDb.url });
    }
    return pool;
  },
};
