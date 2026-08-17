-- Identity moves to Supabase; CockroachDB stops being an identity provider.
--
-- 002_pin_auth.sql opened with "deliberately not Cognito/Supabase" and it was
-- right for what it was: a single-actor app that only needed to attribute rows
-- to a person. What broke it was not the PIN, it was the *cookie*. The frontend
-- is on Amplify and the API is on ECS, which are unrelated domains, so the
-- session cookie between them was necessarily third-party — `SameSite=None;
-- Secure` and at the mercy of every browser's tracking-prevention policy,
-- which Safari's ITP blocks outright. There is no fix for that inside a
-- self-hosted session table; the credential had to stop being a cookie.
--
-- So: Supabase issues the actor an access token, this API verifies its
-- signature against Supabase's published public key (see
-- api/src/features/auth/supabaseJwt.ts), and nothing about a password or a
-- browser session lives here any more.
--
-- What stays exactly as it was: every `user_id UUID` column. Supabase user ids
-- are UUIDs too, so the columns keep their type, their indexes and their
-- meaning — they simply now hold an id minted elsewhere. That is the whole
-- reason this migration is six DROPs and no data movement.
--
-- What IS deleted, deliberately: every row belonging to one of those local
-- accounts. They are orphaned the moment `users` goes — no Supabase id will
-- ever match one — and while they are inert (every query is scoped by
-- `user_id`, so an unmatched owner is a row nobody can read), leaving them
-- means the mastery and mistake tables permanently carry practice history that
-- belongs to nobody and can never be shown to anyone. This was a judgement
-- call, taken explicitly rather than by default; the alternative was to leave
-- them and re-attribute later, which nothing in the app can do.
--
-- Read before applying: CockroachDB runs schema changes as asynchronous jobs,
-- so BEGIN/…/ROLLBACK does *not* undo any of the statements below (see
-- CLAUDE.md). There is no dry run. This one drops tables and deletes rows.

-- Children before parents, or the FKs *among* these tables reject the deletes.
-- Scoped by `IN (SELECT id FROM users)` rather than by a literal id list: it
-- says what is being deleted (everything owned by a local account) instead of
-- which rows happened to exist on the day this was written, and it becomes a
-- clean no-op rather than a wrong delete if it is ever run against a database
-- where somebody had already cleaned up. The subquery has to come before the
-- DROP below, which is why the order of this file matters.
DELETE FROM recordings WHERE session_id IN (
    SELECT id FROM session_history WHERE user_id IN (SELECT id FROM users));
DELETE FROM mistake_log WHERE user_id IN (SELECT id FROM users);
DELETE FROM session_beat_score WHERE session_id IN (
    SELECT id FROM session_history WHERE user_id IN (SELECT id FROM users));
DELETE FROM block_coaching WHERE session_id IN (
    SELECT id FROM session_history WHERE user_id IN (SELECT id FROM users));
DELETE FROM session_block WHERE session_id IN (
    SELECT id FROM session_history WHERE user_id IN (SELECT id FROM users));
-- Two separate FKs into session_history (`session_id` and `followed_session_id`),
-- so scoping by owner is what clears both at once.
DELETE FROM coach_recommendation WHERE user_id IN (SELECT id FROM users);
DELETE FROM line_mastery WHERE user_id IN (SELECT id FROM users);
DELETE FROM roles_in_progress WHERE user_id IN (SELECT id FROM users);
DELETE FROM session_history WHERE user_id IN (SELECT id FROM users);

-- The foreign keys have to go before the table they point at. Named explicitly
-- rather than looked up, because these are CockroachDB's own generated names
-- (verified against pg_constraint on the live cluster) and IF EXISTS makes a
-- re-run a no-op rather than an error.
ALTER TABLE roles_in_progress DROP CONSTRAINT IF EXISTS roles_in_progress_user_id_fkey;
ALTER TABLE session_history DROP CONSTRAINT IF EXISTS session_history_user_id_fkey;
ALTER TABLE line_mastery DROP CONSTRAINT IF EXISTS line_mastery_user_id_fkey;
ALTER TABLE mistake_log DROP CONSTRAINT IF EXISTS mistake_log_user_id_fkey;
ALTER TABLE coach_recommendation DROP CONSTRAINT IF EXISTS coach_recommendation_user_id_fkey;

-- "A logged-in browser session", which is now a Supabase refresh token the
-- browser holds and this database has no opinion about. 002 was careful to name
-- this distinctly from `session_history`, which is the rehearsal kind of
-- session and stays.
DROP TABLE IF EXISTS auth_sessions;

-- name, username, pin_hash, failed_pin_attempts, locked_until — every column
-- here is now Supabase's to hold, and holding a second copy of an identity is
-- how the two versions of "what is her name" drift apart.
DROP TABLE IF EXISTS users;
