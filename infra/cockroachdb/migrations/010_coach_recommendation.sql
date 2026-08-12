-- What the coach told her to do, so it can find out whether she did it.
--
-- Migration 008 added `session_block.source` ('user' | 'coach') to make a
-- recommendation checkable. That covers half of it: a block the coach chose is
-- marked as such **once she has started a session containing it**. A
-- recommendation she read and ignored is recorded nowhere at all, so the one
-- question that makes this loop agentic rather than merely generative —
-- *"last time I said run these three; you ran two"* — has no data behind it.
--
-- An agent that cannot tell what it told you to do cannot act on its own
-- memory. It can only ever produce a fresh opinion, which is a chatbot.
--
-- ## Why a table rather than an unstarted session
--
-- The obvious alternative is to create the drill session immediately, with
-- `scope: 'blocks'` and `source: 'coach'`, and treat "did it get any beats" as
-- adherence. That was rejected: it fills `session_history` with rehearsals that
-- never happened, and every count of "sessions run" then has to know to exclude
-- them. A recommendation is a different kind of thing from a rehearsal and gets
-- its own row.
--
-- ## Shape
--
-- `block_ids` is an array rather than a join table. A recommendation is written
-- once and read whole — it is never queried by "which recommendations mentioned
-- this block" — so the join table would be three tables' worth of ceremony for a
-- list of two or three ids. `session_block` remains the normalized record of
-- what a session actually covered; this is only what was *suggested*.
--
-- No foreign key on `block_ids`, for the same reason `session_block` and
-- `block_coaching` have none: `block_id` is not unique in `lines`, by
-- definition, since a block is many beats.
--
-- `followed_session_id` is filled in later, when a session turns up that covers
-- what was recommended. NULL therefore means one of two things — not followed
-- yet, or not followed at all — and the difference is `created_at` plus however
-- long the reader thinks is fair. Deliberately not a boolean: "did she do it"
-- has no answer at the moment the recommendation is written.

CREATE TABLE IF NOT EXISTS coach_recommendation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    play_id UUID NOT NULL REFERENCES plays(id),
    -- The session that prompted it — the run she had just finished. Null-safe
    -- for a recommendation made outside a session (the play page, later).
    session_id UUID REFERENCES session_history(id),
    -- What it said, in her language. One or two sentences; this is the thing
    -- she actually reads.
    note TEXT NOT NULL,
    -- What it wants her to do next. 'drill' names blocks; 'scene' names a whole
    -- scene; 'none' is a real answer — a run with nothing worth saying should
    -- say nothing rather than invent an action.
    action TEXT NOT NULL DEFAULT 'none',
    -- Set for both 'drill' and 'scene', so the client can route without
    -- re-deriving anything.
    act TEXT,
    scene TEXT,
    block_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    -- Which tools it called, in order, as JSON. Not for the product — for being
    -- able to answer "why did it say that" without re-running it. An agent
    -- whose reasoning cannot be inspected is very hard to trust or to debug.
    tool_calls JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The session that satisfied it, once one does.
    followed_session_id UUID REFERENCES session_history(id),
    CONSTRAINT coach_recommendation_action_check
        CHECK (action IN ('none', 'drill', 'scene'))
);

-- "Her most recent recommendation for this play" is the only read pattern —
-- both for showing it and for asking whether the last one was followed.
CREATE INDEX IF NOT EXISTS coach_recommendation_recent_idx
    ON coach_recommendation (user_id, play_id, created_at DESC);
