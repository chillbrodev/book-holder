-- Per-character Polly voice, replacing the POLLY_VOICE_MAP env var.
--
-- characters is already play-scoped (play_id), so a column here lets two
-- plays' same-named characters carry different voices, and lets a voice be
-- changed with an UPDATE instead of an env var edit + redeploy. NULL means
-- "no assignment yet" — PollyService falls back to POLLY_DEFAULT_VOICE_ID.

ALTER TABLE characters
    ADD COLUMN IF NOT EXISTS polly_voice_id TEXT;
