-- Why the coach picked what it picked, in its own words.
--
-- `coach_recommendation.note` is what she reads: a quoted line, what keeps
-- happening to it, what to do. What it never said was *why this speech and not
-- another* — the marks behind the choice. Without that the recommendation is an
-- instruction; with it, it is an argument she can disagree with, which is the
-- difference between a coach and a notification.
--
-- A separate column rather than more sentences appended to `note`, because the
-- two are read differently: the note is addressed to her, the rationale is the
-- evidence under it, and the screen sets them apart. Folding them together would
-- make that impossible to undo later.
--
-- Nullable, and deliberately so. Every row written before this existed has no
-- rationale and never will; NULL says "not recorded", which is the truth, where
-- an empty string would say "it declined to give one". The agent can also fail
-- to supply it on a future run without that costing the recommendation — the
-- note is the part that must be there.
--
-- Additive and IF NOT EXISTS, per the rule this repo's migrations follow:
-- CockroachDB runs schema changes as asynchronous jobs, so BEGIN/ROLLBACK does
-- not undo them and there is no dry run. Adding a nullable column is the safest
-- shape a migration here can take — nothing is read, moved, or dropped.

ALTER TABLE coach_recommendation
    ADD COLUMN IF NOT EXISTS rationale TEXT;
