-- Beats and blocks — see docs/beats-and-blocks-plan.md §5.
--
-- `lines` stops holding one row per line of verse/prose and starts holding one
-- row per *beat*: one thought, which is what the coach scores, what "Line?"
-- prompts with, and what line_mastery keys on. Display and Polly work on the
-- *block* (a speech, cut wherever a stage direction falls inside it), which the
-- importer now materializes as block_id rather than anything re-deriving it at
-- read time.
--
-- DESTRUCTIVE. Re-importing mints new UUIDs for every row, so all existing
-- play/character/line data is deleted here and reloaded by the importer. Safe
-- only because no real rehearsal history exists yet — once line_mastery has
-- her actual practice in it, this migration is no longer cheap.

-- 1. Clear the old rows. Deletes run child-first so the FKs stay satisfied, and
--    the new columns below are NOT NULL with no default, which cannot be added
--    to a populated table.
DELETE FROM mistake_log;
DELETE FROM line_mastery;
DELETE FROM line_speakers;
DELETE FROM lines;
DELETE FROM stage_directions;
DELETE FROM recordings;
DELETE FROM session_history;
DELETE FROM roles_in_progress;
DELETE FROM characters;
DELETE FROM plays;

-- 2. Beat/block columns.
--
-- line_number keeps its name and its index but changes meaning: it is now the
-- scene-local *beat* sequence. Renaming it would churn every query and every
-- raw row type in the API for no behavioural gain; stage_directions.
-- after_line_number likewise now anchors to a beat.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS block_id UUID NOT NULL;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS beat_number INT NOT NULL;

-- The original <LINE> texts this beat spans. Required, not optional insurance:
-- verse is memorized by its lineation, and the joined `text` cannot reproduce
-- it — mid-sentence capitals are all that survive. Retrofitting it would mean
-- another full re-import.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS source_lines STRING[] NOT NULL;

-- True when the beat boundary fell mid-line, so source_lines[0] repeats the
-- previous beat's last entry and block-level verse display drops it. Stored
-- rather than inferred by comparing text, because a song refrain can
-- legitimately repeat an identical line inside one block (3 occurrences across
-- the corpus) and string equality would silently swallow the repeat.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS shares_first_source_line BOOL NOT NULL;

-- Block-level. Verse keeps its lineation on screen; prose is wrapped to the
-- container, since its "lines" are only Moby's fixed-width typesetting. Moby
-- records no marker, so the importer derives it from the lineation itself.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS is_verse BOOL NOT NULL;

-- Serves both "give me this block's beats in order" (the audio endpoint and
-- block display) and the ORDER BY that follows it.
CREATE INDEX IF NOT EXISTS lines_block_idx ON lines (block_id, beat_number);

-- 3. Embedding dimension: 1536 was Titan G1's output. Titan Text Embeddings V2
--    — the model actually intended (docs/beats-and-blocks-plan.md §8) — emits
--    1024 by default, and the column width must match the model exactly or
--    every insert fails.
--
--    Dropped and re-added rather than ALTER ... TYPE: CockroachDB restricts
--    column-type changes that need a rewrite, and both columns are all-NULL, so
--    there is nothing to preserve.
ALTER TABLE lines DROP COLUMN IF EXISTS embedding;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);
ALTER TABLE mistake_log DROP COLUMN IF EXISTS embedding;
ALTER TABLE mistake_log ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);
