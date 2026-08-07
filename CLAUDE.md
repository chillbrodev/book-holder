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

`.env` lives at the **repo root** and is shared by `api/`, the importer, and the migrator.
`api/` reads it via `../.env` — which is why its deno tasks grant `--allow-read=../.env`.

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

`lines.line_number` is the scene-local *beat* sequence despite the name; renaming it
would churn every query for no behavioural gain.

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

## Database

CockroachDB via `pg`. One thing bites repeatedly:

**`pg` returns 64-bit INTs as strings**, not numbers, to avoid precision loss. Every raw
row type reflects that (`number | string`), and the `Number()` calls at mapping
boundaries are deliberate, not decoration. Don't "clean them up".

Aggregate columns shared across queries live in constants (`BEAT_COLUMNS`,
`SPEAKER_COLUMNS` in `features/plays/service.ts`) because several queries feed one
mapper — a column added to only some of them arrives as `undefined` at runtime rather
than failing to compile.

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
`.env` deliberately says `LOCAL`, and only `COCKROACHDB_URL` / `ALLOWED_ORIGIN` flow
from that file to production, via Secrets Manager. Editing `DENO_ENV` there does nothing.

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
