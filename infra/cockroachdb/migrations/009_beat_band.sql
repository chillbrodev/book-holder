-- The band, stored rather than derived.
--
-- Design and reasoning: docs/coaching-plan.md §3 and §6. §6 chose to derive the
-- band from `confidence_score` at read time and stated the condition under which
-- that would stop being right:
--
--   "retuning a threshold silently re-bands every past session... That is
--    acceptable while the thresholds are unsettled and the history is days old;
--    it stops being acceptable once either of those changes, and the fix at that
--    point is a band column on session_beat_score, written at insert time."
--
-- Both halves have now arrived, from the opposite direction to the one that
-- section anticipated. The thresholds are *still* unsettled — `OPEN_ITEMS.md`
-- §1a — and two screens now need bands and cannot derive them without inventing
-- the two cuts nobody is ready to choose:
--
--   * the wrap-up shows a count of flagged beats instead of bands, only because
--     rendering a band would have meant picking numbers at the render layer;
--   * the Prompt Book's mastery bar is a count of beats she *has*, which is the
--     same question with the same missing cut.
--
-- The band is not a derived value we are caching. It is a judgement the model
-- makes and returns on every scored beat, and which was being discarded. Storing
-- it is the smaller invention: asking a model that is already judging meaning
-- for the judgement, rather than fitting two constants to stand in for it.
--
-- `confidence_score` stays exactly as it is, and stays the thing thresholds will
-- eventually be fitted to. When §1a is settled the derivation can take over and
-- these columns become a record of what the model said at the time — which is
-- worth having anyway, since it is the only way to check the two against each
-- other.
--
-- ## Nullable, deliberately
--
-- The deterministic fallback (`features/sessions/score.ts`, used whenever
-- Bedrock is unreachable) answers two bands, not three: word recall can see
-- solid and dry and is blind to *close*, which is the semantic case. Rather than
-- have the fallback assert a band it cannot know, a beat scored without the
-- model is free to carry NULL. NULL means "not banded", never "not solid" —
-- anything counting mastery must therefore count `band = 'solid'` rather than
-- `band <> 'dry'`.
--
-- Existing rows: there are none scored before this migration that matter — the
-- corpus was re-imported and the memory tables were emptied the same day.

ALTER TABLE session_beat_score
    ADD COLUMN IF NOT EXISTS band TEXT
    CHECK (band IS NULL OR band IN ('solid', 'close', 'dry'));

-- The *latest* band for a beat, matching `confidence_score`'s meaning on the
-- same row: how well does she know this line now. The history of how often she
-- has missed it lives in `mistake_count`, which only accumulates — two columns,
-- two questions, and the band belongs to the first of them.
ALTER TABLE line_mastery
    ADD COLUMN IF NOT EXISTS band TEXT
    CHECK (band IS NULL OR band IN ('solid', 'close', 'dry'));
