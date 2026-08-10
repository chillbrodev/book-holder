-- Coaching, and the session lifecycle change that makes it possible.
--
-- Design and reasoning: docs/coaching-plan.md. This file records the parts a
-- reader of the schema alone would otherwise have to reverse-engineer.
--
-- The change underneath all of it: **a session row is now created when the
-- rehearsal starts, not when it is saved.** Coaching is scored per block, as
-- each block finishes, so there has to be a session to write into before the
-- scene ends. The alternative — accumulating in memory and writing once at the
-- end — is what exists today, and it was about to become a loop of network
-- calls inside an open serializable transaction.
--
-- Two consequences that are not schema changes but are easy to trip over:
--
--   * `duration_seconds` and `beats_run` are both already nullable, so a row
--     can be created before either is known. No ALTER needed for that.
--   * `beats_run` changes meaning slightly from migration 005. There, NULL meant
--     "written before this column existed, genuinely unknown". It still does —
--     but a *new* session now starts at 0 and counts up as blocks complete, so 0
--     means "in progress, none finished yet" rather than "ran none". NULL and 0
--     are still different answers; there is now a third state (rising) that 005
--     did not anticipate.
--
--   * Abandoned rehearsals leave real rows. Accepted deliberately — a partial
--     rehearsal is still a rehearsal, and today abandoning a scene loses the
--     whole run. Cleanup is not solved here and does not need to be.


-- The stored scene summary: the encouraging wrap-up note written once, at scene
-- end, by the low-frequency Bedrock call.
--
-- Stored rather than generated per view for two reasons, and the second matters
-- more: generating on view bills a model call on every refresh, and it produces
-- *different words for the same rehearsal* each time. A coaching note that
-- rewords itself when she reloads the page is not a record of how the run went.
--
-- Nullable with no default: a session in progress has no summary yet, and an
-- abandoned one never gets one. NULL means "not written", which a reader should
-- render as absence rather than as an empty note.
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS coaching_note TEXT;

-- When the scene was actually finished, as opposed to started.
--
-- `duration_seconds IS NOT NULL` would technically answer the same question,
-- since it is only filled at the end — but that is an accident of write order,
-- not a statement of intent, and the first person to give duration a default
-- would silently break every query relying on it. An explicit column says what
-- it means.
--
-- This is what stops an abandoned session shadowing a real one: getSessionSummary
-- falls back to the latest run for a scene, and without this, starting a scene
-- and walking away would make *that* row the newest — so re-opening an old
-- wrap-up would show an empty rehearsal instead of the one she finished.
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;


-- What she scored on each beat, in *this* session.
--
-- This table looks redundant against two existing ones and is not. The
-- distinction is worth stating plainly, because merging any two of them would
-- quietly destroy something:
--
--   * `line_mastery` is keyed (user_id, line_id) and holds only the **latest**
--     recall — it answers "how well does she know this now". Reading a past
--     session out of it is impossible by construction: the second run of a scene
--     overwrites the first.
--   * `mistake_log` is filtered to **misses on purpose** and is the cross-session
--     "what went wrong" record that the nearest-neighbour work (OPEN_ITEMS §2)
--     will run over. Adding correct deliveries to it would bury the signal it
--     exists for.
--   * This table is the **session's own record**, misses and successes alike.
--
-- It is also what makes deriving the band possible at all. coaching-plan.md §6
-- chose to derive *solid* / *close* / *dry* from `confidence_score` at read time
-- rather than store the band, so that the thresholds (OPEN_ITEMS §1a, still
-- unsettled) can be retuned freely. Deriving requires the underlying score to
-- still be there for every beat of every past session — which is exactly what
-- neither table above keeps.
--
-- The accepted cost of deriving, restated here so it is not discovered later:
-- retuning a threshold silently re-bands history. A run she remembers as solid
-- can become close. That is fine while the thresholds are days old and moving;
-- when it stops being fine, the fix is a band column written at insert time, and
-- this table is where it goes.
CREATE TABLE IF NOT EXISTS session_beat_score (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES session_history(id),
    line_id UUID NOT NULL REFERENCES lines(id),
    -- Continuous, 0..1, exactly as line_mastery stores it. The band is a
    -- presentation of this number and never a column.
    confidence_score FLOAT NOT NULL,
    -- What she actually said. **Empty string means she said nothing**, which is
    -- information rather than a missing value — the same convention mistake_log
    -- uses, and one of the most useful things the wrap-up can show.
    heard TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One score per beat per session. A block re-delivered inside the same
    -- session upserts rather than accumulating a second row, so the session
    -- always reflects her most recent attempt at each beat.
    UNIQUE (session_id, line_id)
);

-- The per-block coaching note shown under the block during the scene, and again
-- in the wrap-up.
--
-- Separate from session_beat_score because a note is per *block* while a score is
-- per *beat* — one Bedrock call covers a block and returns both (coaching-plan.md
-- §2). Folding the note onto every beat row would repeat it N times and invite a
-- reader to wonder which copy is authoritative.
CREATE TABLE IF NOT EXISTS block_coaching (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES session_history(id),
    -- No foreign key, because there is no blocks table to point at: `block_id`
    -- is a column on `lines` (migration 004), materialized by the importer as a
    -- content-derived UUIDv5 so that re-importing unchanged text keeps the same
    -- id. A REFERENCES lines(block_id) is not available — block_id is not unique
    -- in `lines`, by definition, since a block is many beats.
    block_id UUID NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One note per block per session, upserted for the same reason as above.
    UNIQUE (session_id, block_id)
);

-- No separate index on session_id for either table: both UNIQUE constraints lead
-- with it, and "everything for this session" is the only access pattern either
-- table has. A second index would be write cost for nothing.
