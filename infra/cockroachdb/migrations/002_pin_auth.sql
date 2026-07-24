-- Username + PIN auth for The Book Holder.
--
-- Deliberately not Cognito/Supabase — this is a single-actor hackathon app
-- (PROJECT_PLAN.md §7 rules out multi-user/networked rehearsal), so basic
-- account identification is all that's needed to attribute session_history/
-- line_mastery/mistake_log rows to a person.
--
-- `auth_sessions` is named distinctly from `session_history` on purpose:
-- the latter means "a rehearsal session," this means "a logged-in browser
-- session" — same word, different concept, worth not colliding on.
--
-- username is stored lowercase by the app layer; CockroachDB has no
-- built-in citext, so case-insensitivity is enforced by convention, not a
-- DB constraint, at this scale.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS pin_hash TEXT,
    ADD COLUMN IF NOT EXISTS failed_pin_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_token_idx ON auth_sessions (token_hash);
