-- The Book Holder — initial schema.
--
-- Deviation from docs/PROJECT_PLAN.md §5: `lines` does NOT carry a single
-- `character_id`. Real play text has speeches with more than one <SPEAKER>
-- (e.g. PAGE, SHALLOW, and SLENDER jointly speaking one line in Merry Wives of
-- Windsor act 1). A single FK would force picking one speaker and silently
-- drop the line for the others when they rehearse that role. `line_speakers`
-- is a many-to-many join instead.
--
-- `embedding` columns are created now (nullable) so the shape is stable, but
-- are left NULL by the importer. CockroachDB vector indexes are v25.2+ and
-- preview-gated (`SET CLUSTER SETTING feature.vector_index.enabled = true`);
-- see infra/cockroachdb/README.md for the follow-up migration once a real
-- embedding model is wired up.

CREATE TABLE IF NOT EXISTS plays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    source_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    play_id UUID NOT NULL REFERENCES plays(id),
    name TEXT NOT NULL,
    description TEXT,
    is_synthetic BOOL NOT NULL DEFAULT false,
    UNIQUE (play_id, name)
);

-- act/scene are flexible labels ("I".."V", "INDUCTION", "PROLOGUE"), per
-- docs/PROJECT_PLAN.md §6 parsing rules 3-4. act_order/scene_order carry the
-- real document order so the app doesn't have to parse roman numerals to sort.
CREATE TABLE IF NOT EXISTS lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    play_id UUID NOT NULL REFERENCES plays(id),
    act TEXT NOT NULL,
    act_order INT NOT NULL,
    scene TEXT NOT NULL,
    scene_order INT NOT NULL,
    scene_description TEXT,
    speech_number INT NOT NULL,
    line_number INT NOT NULL,
    text TEXT NOT NULL,
    stage_direction TEXT,
    embedding VECTOR(1536),
    UNIQUE (play_id, act, scene, line_number)
);

CREATE TABLE IF NOT EXISTS line_speakers (
    line_id UUID NOT NULL REFERENCES lines(id),
    character_id UUID NOT NULL REFERENCES characters(id),
    PRIMARY KEY (line_id, character_id)
);

-- Blocking cues ("Enter SHALLOW...", "Exeunt", "Knocks") — not spoken lines,
-- but real content (215 occurrences in Merry Wives alone, both between
-- speeches and interleaved mid-speech, e.g. "Knocks" between two lines of the
-- same speaker). Not in the original PROJECT_PLAN.md data model; added
-- because the importer already walks these nodes and discarding them would
-- lose staging/entrance cues for no reason.
CREATE TABLE IF NOT EXISTS stage_directions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    play_id UUID NOT NULL REFERENCES plays(id),
    act TEXT NOT NULL,
    act_order INT NOT NULL,
    scene TEXT NOT NULL,
    scene_order INT NOT NULL,
    sequence INT NOT NULL,
    after_line_number INT NOT NULL,
    text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles_in_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    play_id UUID NOT NULL REFERENCES plays(id),
    character_id UUID NOT NULL REFERENCES characters(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    play_id UUID NOT NULL REFERENCES plays(id),
    act TEXT NOT NULL,
    scene_range TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_seconds INT
);

CREATE TABLE IF NOT EXISTS line_mastery (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    line_id UUID NOT NULL REFERENCES lines(id),
    confidence_score FLOAT NOT NULL DEFAULT 0,
    last_practiced_at TIMESTAMPTZ,
    mistake_count INT NOT NULL DEFAULT 0,
    UNIQUE (user_id, line_id)
);

CREATE TABLE IF NOT EXISTS mistake_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    line_id UUID NOT NULL REFERENCES lines(id),
    session_id UUID NOT NULL REFERENCES session_history(id),
    what_was_said TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES session_history(id),
    s3_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lines_play_order_idx
    ON lines (play_id, act_order, scene_order, line_number);
CREATE INDEX IF NOT EXISTS line_mastery_user_line_idx
    ON line_mastery (user_id, line_id);
CREATE INDEX IF NOT EXISTS mistake_log_user_idx
    ON mistake_log (user_id, line_id);
