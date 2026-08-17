# The Book Holder

A rehearsal partner for actors: it voices every character but yours, listens to your
lines, and remembers what you've mastered. Focus play is *The Merry Wives of Windsor*,
but nothing is hardcoded to it — adding a play is an import, not a schema change.

## Layout

| Path | What | Runtime |
|---|---|---|
| `api/` | Hono API | **Deno** |
| `frontend/` | React 19 + Vite | Node / npm |
| `packages/play-importer/` | Parses Moby Shakespeare XML into DB rows | Node / tsx |
| `infra/cockroachdb/` | Schema + migrations | tsx |
| `infra/aws/` | Deploy + bootstrap scripts | bash |
| `docs/` | Design docs — read before changing a subsystem |

`api/` is Deno and the rest is Node. Don't reach for `npm` inside `api/`, or `deno` outside it.

## Commands

```bash
npm run dev                  # frontend + api together (from repo root)

cd api
deno task dev                # watch mode
deno task test               # all API tests
deno check src/main.ts       # typecheck
deno fmt src/                # format — CI-relevant, run before committing

cd frontend
npm run dev
npx tsc -b                   # typecheck
npx oxlint                   # lint

npm run db:migrate           # from repo root
npm run import:play -- …     # from repo root
```

```bash
cd api                       # probes: real AWS, real DB, billed, not part of `deno task test`
deno task test-coach-block       # rubric vs real Nova — 4 synthetic beats, one per case
deno task test-capture-socket    # ready -> complete -> scored over the real socket
deno task test-session-lifecycle # start/record/complete writes, then deletes what it made
deno task embed-beats            # backfill lines.embedding; dry run unless --yes
```

**One `.env` per runtime, and there is no repo-root one.** `api/.env` and `frontend/.env`,
each read only by its own side. Deploys read neither — CI injects the container's environment
and Vite inlines the frontend's at build time.

- `api/.env` — `deno task` sets CWD to `api/`, so `loadSync` needs no path and the tasks grant
  `--allow-read=.env`. Running `deno run src/main.ts` by hand from elsewhere won't find it.
- `frontend/.env` — Vite reads only this. A `VITE_` var anywhere else looks right and does nothing.
- **`infra/cockroachdb/migrate.ts` and `packages/play-importer` also read `api/.env`**, by
  explicit path, for `COCKROACHDB_URL`. Deliberate: a second copy of a database URL is how the
  migrator applies schema to a cluster the API isn't reading, which surfaces as "the migration
  ran but nothing changed" rather than as an error.

## Domain model: beats and blocks

The single most important distinction in this codebase, and the one most likely to
cause a wrong change. See `docs/beats-and-blocks-plan.md`.

- A **beat** is one thought. It's a row in `lines`, and it's what the coach scores
  and what `line_mastery` keys on. It is *not* a line of verse.
- A **block** is one speech, cut wherever a stage direction falls inside it. It's the
  unit of **display** and of a **single Polly render**, grouped by `block_id`.

So: score per beat, render and display per block. Audio is synthesized for a whole
block at once — rendering beat by beat gives each fragment sentence-final intonation
and a trailing pause, which is audible as stop-start delivery and baked into the bytes.

**Coaching is scored per beat but *called* per block** (`docs/coaching-plan.md`). One
Bedrock call covers a whole speech and returns a result per beat — the block gives the
model the context that makes a paraphrase judgeable, but the beat is still the scored
unit and still what `line_mastery` keys on. Don't read "one call per block" as "one
score per block".

`lines.line_number` is the scene-local *beat* sequence despite the name; renaming it
would churn every query for no behavioural gain.

**`lines.beat_number` is not that sequence** — it is the beat's index *within its
block*, so three of four consecutive beats in II.i are all `beat_number` 1.
`ORDER BY beat_number` across a scene returns essentially arbitrary order, compiles
fine, and looks perfect until more than one beat comes back. Order by `line_number`.
This was written wrong once and only surfaced in real output.

Verse keeps its lineation on screen (`source_lines`); prose is wrapped, because its
"lines" are only the source's fixed-width typesetting.

## Content-derived IDs

`packages/play-importer/src/ids.ts` derives `block_id` and line IDs as UUIDv5 hashes
over the play/act/scene/speakers/**text**. Consequences worth holding in your head:

- Re-importing unchanged text produces the **same IDs**, so cached audio and practice
  history survive. This is deliberate — `randomUUID()` previously made every import
  silently invalidate both.
- Changed text produces **new IDs**, so it re-renders and re-learns. Also correct.
- Therefore a stale render can never hide behind a live ID *for text reasons* — but it
  absolutely can for other reasons. See below.
- The namespace constant must never change, or every ID in every play changes with it.

## Polly / audio cache — read this before touching it

Cache key: `{play}/{character}/{blockId}__{voiceId}__{engine}.mp3` in S3.

**Engine is `neural`, deliberately, and must not go back to `generative`.** Generative is
LLM-based and non-deterministic; it occasionally renders invented sentences past the end
of the text. Three blocks were cached that way. Full write-up in
`docs/polly-gen-issue.md`. Neural returns byte-identical audio for identical input.

Things that are easy to get wrong here:

- **Anything that varies the audio must be in the cache key.** The engine wasn't, which
  is exactly how bad renders survived an engine change. A cache hit is an S3
  `objectExists` — existence, not validity — and nothing ever re-renders on its own.
- **`synthesizeAndCache` guards duration** (`assertPlausibleLength`): a render longer
  than 1.75× what its text can account for is discarded, not cached. The threshold is
  calibrated against the corpus, not guessed. If you change voices, engine, or the
  speech-rate constants, re-check it.
- **Neural throttles hard.** Bulk warming needs the client's `retryMode: "adaptive"`
  and low `--concurrency`; a first pass at concurrency 6 lost 254 of 1064 blocks to
  `ThrottlingException`. This applies to the live endpoint too, which synthesizes on miss.
- **`warm-polly-cache` is billed and defaults to a dry run.** Keep it that way. It must
  key identically to `getBlockAudio` or the whole pass is wasted.

> **Hitting `/polly/blocks/…` against a deployed environment is not a read-only check.**
> A cache miss bills a synthesis *and writes an S3 object*. Don't use it to smoke-test a
> deploy. Use `/health` (see below).

## Bedrock

Comparison model is **`us.amazon.nova-micro-v1:0`**, and the `us.` prefix is load-bearing.
Nova Micro has no in-region presence in `us-west-2`, so it is reachable only through the
US geo inference profile; the bare `amazon.nova-micro-v1:0` fails from this region with an
error that reads like a bad model id rather than a regional gap. This is the *opposite* of
the rule for models with no profile, where the bare id is the only thing that works — so
don't pattern-match one onto the other.

Consequences that bite:

- **A profile invocation needs two ARN shapes in IAM**: the inference-profile ARN *and* the
  foundation-model ARN in every region the profile routes to. Granting only the profile
  fails with an `AccessDenied` naming a region that appears nowhere in the deployment.
  Both `infra/aws/create-dev-user.sh` and `infra/aws/ecs-deploy.sh` carry them; changing
  the model means changing both files, not one config string.
- **Nova does not support structured outputs.** The response shape comes from a forced
  single-tool call, which Nova *does* honour — verified with a real Converse call
  (`recoveredFromText: false`, 571 ms, 523 in / 43 out tokens for one beat).
  `BedrockClient.converseJson` still falls back to scraping JSON out of prose; if
  `recoveredFromText` ever comes back true the toolChoice shape has broken, and widening
  the parser is the wrong fix.
- **No console step is needed to enable a model.** Bedrock retired the Model access page —
  serverless foundation models enable on first invocation. Older notes calling this a
  blocking human step are out of date.
- **`BEDROCK_MODEL_ID_COMPARISON` has a working default in `configClient.ts`**, so it is
  passed to the container only when set. The real deploy path reads it from a GitHub
  repository variable; `ecs-deploy.sh` reads it from the environment.
- **Bedrock pricing is separately set from first-party Anthropic pricing** and could not be
  verified from the pricing page. Don't quote first-party rates as Bedrock rates.

**Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) is the opposite ARN shape to
Nova and must not be pattern-matched onto it.** Titan *is* available in-region, has no
inference profile, and takes exactly one bare foundation-model ARN. Nova needs a profile
ARN plus foundation-model ARNs in three regions. Both grants live in
`create-dev-user.sh` **and** `task-role-policy.sh` — adding a model is always two files.

## Coaching

`features/coaching` — one Bedrock call per **block**, returning a band per **beat** plus
one note. Scored per beat, called per block; `docs/coaching-plan.md` is the design.

- **It can never block a rehearsal.** Every failure path falls back to `score.ts`'s word
  recall and says so in `source`. The socket sends `scored` after `complete`; the client
  must never wait on it to keep rehearsing.
- **The rubric's central job is knowing it reads a speech-to-text transcript.** Without
  that it critiques punctuation an actor never typed. Three revisions were needed, and the
  lesson that made them land: **a procedure works where a principle doesn't.** "Mangled
  proper nouns are the transcriber's fault" failed twice; *"strike out every proper noun
  and archaic word, then judge what is left"* worked immediately.
- **Notes are filtered in code, not by the prompt.** `groundedNote` drops any note that
  shares no three-word run with the written speech. Nova kept returning *"All beats are
  dry"* through three rubric revisions — the rule is mechanically checkable, so it is
  checked. Don't try to fix this in the prompt again.
- `deno task test-coach-block` is the regression for all of it and fails on an ungrounded
  note. Re-run it after touching the rubric.

## Auth

**Supabase is the identity provider, for email/password and nothing else.** No Postgres, no
storage, no realtime — the play, the rehearsals and every score stay in CockroachDB behind
our own API.

**There is no `users` table** (migration 011). `user_id` columns are still `UUID` and still
mean the same thing; they hold the Supabase user's id, with no local row and no foreign key
behind them. A join to `users` will not compile against this schema, and adding one back
would recreate the drift the move was meant to end.

- **The reason for the move was the cookie, not the PIN.** The frontend (Amplify) and the API
  (ECS) are unrelated domains, so a session cookie between them was necessarily third-party:
  `SameSite=None; Secure`, and blocked outright by Safari's ITP. The credential had to stop
  being a cookie. It is now `Authorization: Bearer <supabase access token>`, and
  `credentials: 'include'` is gone from the frontend clients — putting it back only forces a
  credentialed CORS preflight for a cookie nobody sends.
- **Verification needs no secret and must not acquire one.** The project signs ES256 and
  publishes the public half at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, so
  `verifySupabaseToken` is a public-key check. `SUPABASE_SECRET` (the `sb_secret_…` admin key)
  can read and rewrite every user in the project and is deliberately **not** passed to the
  container. If a change seems to need it, the change is probably wrong.
- **`SUPABASE_URL` is required and has no default**, so a container without it throws on boot
  rather than silently accepting nothing. It is wired as plain env (not a secret) in both
  `.github/workflows/deploy-api.yml` and `infra/aws/ecs-deploy.sh` — as ever, two files.
- **The capture socket takes its token as a WebSocket subprotocol**, `["bearer", "<jwt>"]`, not
  a query parameter: a browser `WebSocket` cannot set headers, and a URL is written into every
  access log along the way. The server echoes the `bearer` sentinel and must echo it *only*
  when one was offered — Deno throws if the selected protocol wasn't in the client's list, and
  a guest offers none. Guest capture working is the case to check after touching this.
- **The socket stays auth-aware but not auth-gated.** An absent *or invalid* token is a guest,
  never an error: a token expiring mid-speech must cost her the writing-down, not the take.

## Database

CockroachDB via `pg`. One thing bites repeatedly:

**`pg` returns 64-bit INTs as strings**, not numbers, to avoid precision loss. Every raw
row type reflects that (`number | string`), and the `Number()` calls at mapping
boundaries are deliberate, not decoration. Don't "clean them up".

**A vector query must bind its probe vector as a parameter, never a subquery.**
`ORDER BY embedding <-> (SELECT …)` plans as a FULL SCAN with no error and no warning;
`<-> $1::VECTOR` plans as `• vector search`. Both return identical rows, and at 1,705 rows
both are fast, so only `EXPLAIN` tells them apart. Same silent failure if the operator
doesn't match the index's op class.

`lines.embedding` and `mistake_log.embedding` are `VECTOR(1024)` (Titan V2's width — the
column and the model must agree exactly or every insert fails), indexed `vector_l2_ops` by
migration 007. **L2 is a choice, not a constraint**: this cluster (v26.2.5) supports `<->`,
`<=>` and `<#>`, verified directly. It is safe because Titan is invoked with
`normalize: true`, so every vector is unit length and L2 and cosine rank identically.
`docs/OPEN_ITEMS.md` §2 said L2 was the only option; that was wrong and is corrected there.

**A session is a set of blocks; a whole scene is one kind of set** (migration 008).
`session_history.scope` is `'scene' | 'blocks'`, and `session_block` records the blocks it
set out to cover — for *both* scopes, so "did she finish" is one question: does every
planned block have all its beats in `session_beat_score`. `source` (`'user' | 'coach'`) is
what makes a coach recommendation checkable against what she actually ran.

Rows are written **per block as it finishes** (`features/sessions/lifecycle.ts`), not once
at scene end. Embedding happens *before* the transaction opens — a Titan call inside an
open serializable transaction, per block, for a whole scene is how this starts producing
retries. Only *dry* beats go to `mistake_log`, and only what she actually **said** is
embedded: a blank has no content to cluster on, and embedding the expected text instead
would mix "what she said" and "what she should have said" into one vector space.

Aggregate columns shared across queries live in constants (`BEAT_COLUMNS`,
`SPEAKER_COLUMNS` in `features/plays/service.ts`) because several queries feed one
mapper — a column added to only some of them arrives as `undefined` at runtime rather
than failing to compile.

> **`BEGIN` … DDL … `ROLLBACK` does not undo the DDL.** CockroachDB runs schema changes
> as asynchronous jobs, so a rolled-back transaction still leaves the tables and columns
> behind — unlike Postgres, where this is the standard way to dry-run a migration. The
> `ROLLBACK` returns successfully and `information_schema` inside the same session can
> still read the objects, so it looks like it worked. Verified the hard way: 006 was
> "validated" this way and persisted. **There is no safe dry run for a migration here.**
> Read the SQL, then apply it for real with `npm run db:migrate`.

**Dev and production share one database.** `infra/aws/.env.production` has its own
`COCKROACHDB_URL`, but the host and database are identical to `api/.env`'s. Anything
run against the local dev database is run against what production reads — including
migrations, which is why they are additive and `IF NOT EXISTS`.

## Deploying

Push to `main` touching `api/**` triggers `.github/workflows/deploy-api.yml` (build →
ECR → roll the ECS Express service). Amplify rebuilds the frontend off the same push,
independently. Both go automatically; there's no manual step.

**`infra/aws/ecs-deploy.sh` is not the deploy path.** It bootstraps infrastructure (IAM
roles, S3 bucket, the service itself) and is a local, occasional, human-run thing.

**Verifying a deploy is actually live:** `GET /health` returns `{version: "<short sha>"}`.
Match it against `git rev-parse --short HEAD`. A 200 alone proves nothing — during a
rollout both revisions answer, so a status check passes instantly and tells you nothing.

A green workflow run means the new version is *answering*, not that the old one has
drained. Both revisions serve behind the same endpoint for a minute or two afterwards,
so a request right after a green run can still hit the old code. If that matters — and
on the `/polly` cache-miss path it does — watch the rollout in the ECS console rather
than trusting the green check.

**`DENO_ENV` is hardcoded `production` in the deploy path**, in both the workflow and
`ecs-deploy.sh`. It is *not* sourced from `infra/aws/.env.production` — the local dev
`api/.env` deliberately says `LOCAL`. From that file, `COCKROACHDB_URL` / `ALLOWED_ORIGIN` reach
production via Secrets Manager and `SUPABASE_URL` as plain env (it is public, and not a
credential). Editing `DENO_ENV` there does nothing.

## Conventions

**Comments explain *why*, at length, and they are load-bearing.** This codebase documents
the reasoning behind non-obvious decisions — why an ID scheme is content-derived, why a
column is in a constant, why an engine was chosen. Match that register: when you make a
decision a future reader would second-guess, write down what you considered. Don't strip
existing comments to make a diff smaller.

**Prefer fixing the signal over documenting the workaround.** The rollout gap above was
fixed in the workflow rather than in a checklist, because a checklist only protects
whoever remembers to read it.

Commit messages: imperative sentence-style subject describing the behaviour change
("Rehearse by beats and blocks, not by lines of verse"), with a body explaining the
reasoning. Branch before committing; `main` is the default branch.

**Verify against reality, not just types.** Several subsystems here (Polly, S3, ECS,
the importer) can typecheck perfectly and still be wrong. Where a claim is checkable —
duration, byte count, row count, served version — check it and report the number.
