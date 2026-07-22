# CockroachDB — provisioning & migrations

## Provisioning

You already have a Serverless cluster and connection string — drop it into `.env` as
`COCKROACHDB_URL` (copy `.env.example` first). No provisioning script needed right now.

If a fresh cluster is ever needed, the `ccloud` CLI can create one non-interactively
(`ccloud cluster create ...`) — worth scripting into this directory later since
`README.md`/`docs/PROJECT_PLAN.md` call out scripted provisioning as a judged
production-readiness signal, not manual console clicks. Not built yet since it isn't
needed today.

## Running migrations

```
npm run db:migrate
```

This runs every `.sql` file in `migrations/`, in filename order, tracking what's been
applied in a `schema_migrations` table so re-running is safe. Each migration runs in
its own transaction.

## Migrations

- `001_init_schema.sql` — plays, characters, lines, line_speakers, stage_directions,
  users, roles_in_progress, session_history, line_mastery, mistake_log, recordings.
  `lines.embedding` / `mistake_log.embedding` are created as nullable `VECTOR(1536)`
  columns but left unpopulated by the importer.

## TODO: vector index follow-up migration

Not written yet — add once a real embedding model is chosen and lines actually have
embeddings (an all-NULL vector column isn't worth indexing). CockroachDB vector
indexes are v25.2+ and preview-gated. Confirmed syntax as of this writing:

```sql
-- once, cluster-wide:
SET CLUSTER SETTING feature.vector_index.enabled = true;

-- then, per column:
CREATE VECTOR INDEX ON lines (embedding);
CREATE VECTOR INDEX ON mistake_log (embedding);
```

Only L2 distance (`vector_l2_ops`) is supported today — no cosine/inner-product
option. If the chosen embedding model's dimension isn't 1536, the column definitions
in `001_init_schema.sql` need a matching migration before this can run (`VECTOR(n)`
is fixed-width). Re-verify this against current CockroachDB docs before writing the
real migration — this was confirmed against the v25.2 docs, not from memory.
