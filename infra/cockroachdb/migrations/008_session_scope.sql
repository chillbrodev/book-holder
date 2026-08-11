-- A session is a set of blocks. A whole scene is one kind of set, not the only
-- kind.
--
-- Design and reasoning: docs/coaching-plan.md §6, which this amends. That
-- section assumed a session and a scene were the same object; they are not, and
-- the difference is how actors actually work — you drill four speeches on the
-- bus and run the scene when you have it.
--
-- ## Why this lands now rather than later
--
-- Every user-memory table is empty at the time of writing: session_history,
-- session_beat_score, block_coaching, mistake_log and line_mastery are all at 0
-- rows. There is no backfill, no migration of meaning, and nothing to
-- reinterpret. The same change against real history costs all three, so it is
-- worth taking the moment.
--
-- ## What did NOT need to change, which is most of it
--
-- The coaching design was already block-shaped — one Bedrock call per block
-- (coaching-plan.md §1), so nothing about scoring moves. More importantly the
-- child tables were already keyed correctly:
--
--   * session_beat_score (session_id, line_id) records exactly which beats ran,
--     whatever the session's scope. "Which blocks did she actually do" is
--     therefore already derivable — join to lines.block_id — and does NOT need
--     a table to express.
--   * block_coaching (session_id, block_id) likewise.
--   * line_mastery (user_id, line_id) is per beat per user and has no concept of
--     a session at all. It is the real long-term memory and it is unaffected,
--     which is also why getSessionPlan already works for any scope.
--
-- So the only thing missing was **intent**. What she actually ran was already
-- recorded; what she meant to run was not, and without it "finished what I
-- chose" and "gave up a third of the way in" are the same row.
--
-- ## session_block holds the intent, for both scopes
--
-- It would have been possible to populate this only for block-scoped sessions
-- and treat a scene as the implicit "all of them". Filling it for both is worth
-- the extra rows: completion becomes one uniform question — does every block in
-- session_block have all of its beats in session_beat_score — instead of two
-- different questions depending on a discriminator. `scope` then explains
-- *why* the set is what it is, and is never load-bearing for a query.
--
-- `source` is the part that earns its keep later. A block the coach recommended
-- and a block she picked herself are both intent, but only one of them is a
-- prescription that can be checked next time: "last time I said run these
-- three; you ran two." An agent that cannot tell what it told you to do cannot
-- act on its own memory, so this is recorded from the start rather than
-- retrofitted once the agent exists.
--
-- No REFERENCES on block_id, for the same reason block_coaching has none: there
-- is no blocks table. block_id is a column on `lines` (migration 004),
-- materialized by the importer as a content-derived UUIDv5, and it is not
-- unique in `lines` by definition — a block is many beats.
--
-- ## One scene per session, deliberately
--
-- A session's blocks all come from one (act, scene). That keeps `act` and
-- `scene_range` on session_history meaningful rather than becoming derived
-- labels, and keeps every scene-keyed query working unchanged. "Drill your ten
-- worst speeches across the play" is a real thing to want and is deliberately
-- not this migration — it would make act/scene_range nullable-in-spirit and
-- push a rethink into every read path. Two sessions is an acceptable answer
-- until it isn't.
--
-- ## completed_at, restated
--
-- Migration 006 added it meaning "reached the end of the scene". It now means
-- "every block in session_block was run to the end", which is the same
-- statement for a scene-scoped session and a defined one for a block-scoped
-- session. Abandoned sessions still leave real rows, still deliberately.

-- The CHECK rides along with the column rather than being added as a separate
-- statement. `ADD CONSTRAINT` has no IF NOT EXISTS form here, so a migration
-- that failed after the ALTER but before the constraint could never be re-run —
-- and CLAUDE.md's warning applies exactly here: CockroachDB runs schema changes
-- as asynchronous jobs, so a failed migration leaves its completed DDL behind.
-- Folding it in keeps the whole file re-runnable under one IF NOT EXISTS.
--
-- 'scene' is the default because every session started from the existing
-- rehearsal route is scene-scoped, so the column is correct for anything
-- written before the block-scoped path exists.
ALTER TABLE session_history
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'scene'
    CHECK (scope IN ('scene', 'blocks'));

CREATE TABLE IF NOT EXISTS session_block (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES session_history(id),
    -- No FK: block_id is not unique in `lines`. See the header.
    block_id UUID NOT NULL,
    -- 'user'  — she chose it, including by choosing the whole scene.
    -- 'coach' — the agent recommended it. The distinction is what makes a
    --           recommendation checkable rather than merely made.
    source TEXT NOT NULL DEFAULT 'user',
    -- The order she meant to run them in. A scene is its natural order; a drill
    -- set may be worst-first. Without it the intent is a bag and the UI has to
    -- invent an order, which would then disagree with the coach's.
    --
    -- `ordinal`, not `position` — POSITION is a SQL string function
    -- (POSITION(x IN y)) and a column of that name has to be quoted at every
    -- use or it parses as a call. Not worth the papercut.
    ordinal INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT session_block_source_check CHECK (source IN ('user', 'coach')),
    -- One row per block per session. Re-adding a block to the same session is
    -- an upsert, matching session_beat_score and block_coaching.
    UNIQUE (session_id, block_id)
);

-- No separate index on session_id: the UNIQUE constraint leads with it, and
-- "every block intended for this session" is the only access pattern — same
-- reasoning as the two tables migration 006 added.
