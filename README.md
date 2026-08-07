# 📖 The Book Holder

*A rehearsal partner with a memory, for actors without a scene partner on demand.*

Built for the **CockroachDB × AWS Hackathon — Build with Agentic Memory**.

---

## What this is

An actress returning to her original career late in life, focused on Shakespeare, needs a scene partner to
rehearse lines. Her real-life partner isn't available on her schedule and isn't always in the mood to read
Shakespeare on demand. **The Book Holder** is that partner: it voices every other character in the scene,
listens to her lines, remembers what she's mastered and what she hasn't, and tells her what to work on next time.

The name is real theater history — the "book holder" was the person backstage in Shakespeare's own company who
held the script and fed actors their forgotten lines. This app does the same job, with an AI that has a memory
that persists across sessions.

This generalizes beyond one household: community theater actors, drama students, ESL learners practicing
dialogue — anyone who can't easily get a live rehearsal partner together on their schedule.

**Focus play for this build:** *The Merry Wives of Windsor*. The data model and importer are built generically
against the full Moby Shakespeare corpus, so adding another play later is a data-import task, not a schema
change.

Full project plan, architecture rationale, and judging-criteria mapping: `docs/PROJECT_PLAN.md`

---

## How memory makes this "agentic," not just "an app with a database"

The design principle behind every technical decision in this repo: **the agent reads memory to decide what
happens next, and writes memory as a direct result of what happened** — not just logging for a dashboard.

- Before a session: the agent reads her per-**beat** mastery scores for the chosen scene and decides what to
  emphasize. A beat is one thought — the unit of scoring throughout, and not the same thing as a line of
  verse (see "Domain model" below).
- During a session: her spoken line is transcribed and semantically compared to the script — not exact match,
  since actors misremember words, not just skip them.
- After a line/scene: mastery scores update, in the same transaction as the session record.
- Periodically: the agent embeds new mistakes and runs a nearest-neighbor vector search against her mistake
  history to find patterns across scenes, and proactively recommends what to rehearse next time.

That loop — **read memory → decide → act → write memory** — is the whole pitch. Everything below is in service
of protecting it.

---

## Repo structure (monorepo)

    book-holder/
    │── frontend/                # React + Vite frontend — picker, rehearsal UI, playback
    │── api/                     # Deno + Hono backend — the rehearsal agent, deployed on AWS ECS (Fargate)
    ├── packages/
    │   ├── shared-types/        # TypeScript types shared between frontend and api (planned, not built yet)
    │   └── play-importer/       # Parses Moby Shakespeare XML and loads it into CockroachDB
    ├── infra/
    │   ├── cockroachdb/         # Schema migrations + the migration runner
    │   └── aws/                 # Bootstrap scripts — ECS/ECR/IAM, Secrets Manager, budget alert
    ├── docs/                    # Design docs — read the relevant one before changing a subsystem
    ├── .env.example
    ├── package.json             # npm workspaces root
    └── README.md                # this file

Uses **npm workspaces** (not pnpm/turborepo) — deliberately the simplest option that does the job, since this
is a solo, out-of-pocket build and there's no benefit to learning new tooling for its own sake. `api` sits
outside the workspace: it's Deno, with its own `deno.json`. **Don't reach for `npm` inside `api/`, or `deno`
outside it.**

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, TypeScript | Fast local dev, simple deploys |
| UI components | Hand-built, CSS Modules over design tokens (`frontend/src/styles/tokens.css`) | No component library — the Shakespearean identity is the point, and the trade is that accessibility primitives are ours to get right (see `docs/FE_PLAN.md` §1–2) |
| Frontend hosting | AWS Amplify Hosting | Connects to this repo, auto-builds `frontend` on push |
| Backend | Deno + Hono | The rehearsal agent's API layer |
| Backend hosting | AWS ECS Express Mode (Fargate-based, auto-provisioned ALB) | AWS's recommended App Runner replacement (App Runner is in maintenance mode as of 2026-04-30); HTTPS termination for mic capture's secure-context requirement — see `docs/PROJECT_PLAN.md` §9 for the real cost breakdown |
| Database | CockroachDB Serverless | Memory layer: sessions, line mastery, mistake embeddings, all transactional |
| LLM | Amazon Bedrock — Nova Micro/Lite (per-beat comparison), a stronger model (session summaries) | Cost-scaled to call frequency. *Not wired up yet.* |
| Voice | Amazon Polly — **neural** engine, one voice per character via `characters.polly_voice_id`, cached in S3 per **block** | Neural, not generative: generative is LLM-based and non-deterministic, and rendered invented sentences past the end of the text (`docs/polly-gen-issue.md`). Cached per block because rendering a speech in fragments is audible as stop-start delivery |
| Listening | Amazon Transcribe | *Not wired up yet.* See `docs/OPEN_ITEMS.md` §1b for the current capture design |
| Recordings | Amazon S3 | Session playback. *Not wired up yet* — S3 today holds the Polly cache |

---

## Getting started (local dev)

    git clone <repo-url> book-holder
    cd book-holder
    npm install

    cp .env.example .env
    # fill in CockroachDB connection string, AWS credentials, Bedrock model IDs — see below

    npm run db:migrate                                        # applies infra/cockroachdb/migrations in order
    npm run import:play -- --play merry_wives_of_windsor       # parses XML, seeds CockroachDB
    npm run dev                                               # runs frontend and api together

`--dry-run` renders the parse to `packages/play-importer/output/<slug>/` (script, characters, beats,
summary) and writes nothing to the database — worth doing first when the parser has changed. `--file <path>`
reads local XML instead of fetching. The importer **refuses to import a play that already exists**, so
re-importing means deleting it first, child tables before parents.

Other commands worth knowing:

    cd api && deno task dev        # watch mode                (Deno, not npm)
    cd api && deno task test       # API tests
    cd api && deno fmt src/        # format — CI-relevant, run before committing
    cd frontend && npx tsc -b      # typecheck
    cd frontend && npx oxlint      # lint

### Environment variables (`.env`)

`.env` lives at the **repo root** and is shared by `api`, the importer, and the migrator. `api` reads it via
`../.env`, which is why its deno tasks grant `--allow-read=../.env` — and why the `production` task doesn't:
ECS injects the task definition's environment directly, so there's no file to read. See `.env.example` for
the full list with defaults; the ones without defaults are:

    COCKROACHDB_URL=              # from the CockroachDB Cloud Console
    AWS_REGION=
    AWS_ACCESS_KEY_ID=            # local dev only — never exposed to the client, and never set in production,
    AWS_SECRET_ACCESS_KEY=        #   where the ECS task role supplies credentials to the same client code
    POLLY_CACHE_BUCKET=           # S3 bucket for cached block audio; see infra/aws/README.md
    BEDROCK_MODEL_ID_COMPARISON=  # not read yet — Bedrock isn't wired up
    BEDROCK_MODEL_ID_SUMMARY=     # not read yet
    S3_RECORDINGS_BUCKET=         # not read yet — recordings aren't built

No AWS keys are ever present in `frontend` — all Bedrock/Polly/Transcribe/S3 calls route through `api`. In
production nothing is read from a file at all: `COCKROACHDB_URL` and `ALLOWED_ORIGIN` arrive via Secrets
Manager, and the deploy path hardcodes `DENO_ENV=production` rather than sourcing it.

The AWS **SDK** (which is what `api` uses — not the AWS CLI) can't consume an `aws login` session; that
credential type isn't in its provider chain. `./infra/aws/create-dev-user.sh` provisions a scoped IAM user
with a permanent key for local dev. See `infra/aws/README.md` for the trade-off.

---

## Domain model: beats and blocks

The most important distinction in this codebase, and the one most likely to cause a wrong change. Full
detail in `docs/beats-and-blocks-plan.md`.

- A **beat** is one thought. It's a row in `lines`, and it's what the coach scores and what `line_mastery`
  keys on. It is *not* a line of verse.
- A **block** is one speech, cut wherever a stage direction falls inside it. It's the unit of **display** and
  of a **single Polly render**, grouped by `block_id`.

So: score per beat, render and display per block. Merry Wives is 1,705 beats in ~1,060 blocks — meaning any
count over `lines` is a beat count, including the ones the UI currently labels "lines".

Two consequences that are easy to get backwards: `lines.line_number` is the scene-local *beat* sequence
despite the name, and verse keeps its lineation on screen (`source_lines`) while prose is wrapped, because
prose "lines" are only the source's fixed-width typesetting.

---

## Data model

Scoped to one play (*Merry Wives of Windsor*) but structured so a second play is a data-import task, not a
schema change. Full detail, including the play-XML parsing rules, is in `docs/PROJECT_PLAN.md` (§5–6); the
migrations themselves are in `infra/cockroachdb/migrations/`.

    plays, characters          -- characters carry their own polly_voice_id
    lines                      -- one row per BEAT, with block_id, source_lines, is_verse, vector embedding
    line_speakers              -- many-to-many: real speeches sometimes have several <SPEAKER>s
    stage_directions           -- blocking cues; not spoken, but real content
    users, auth_sessions       -- username + PIN; auth_sessions is a browser session, not a rehearsal one
    roles_in_progress
    session_history
    line_mastery               -- read before a session, written after, in one serializable transaction
    mistake_log                -- vector embedding per mistake, feeds nearest-neighbor pattern search
    recordings

Two things bite repeatedly. **`pg` returns 64-bit INTs as strings**, not numbers, so raw row types say
`number | string` and the `Number()` calls at mapping boundaries are deliberate. And **row ids are
content-derived** (UUIDv5 over play/act/scene/speakers/text, `packages/play-importer/src/ids.ts`), so
re-importing unchanged text produces the same ids and cached audio and practice history survive; changed
text produces new ids and re-renders. The namespace constant must never change.

---

## Deployment

Both halves deploy automatically off a push to `main`. There is no manual step.

- **Backend:** a push touching `api/**` runs `.github/workflows/deploy-api.yml` — builds `api/Dockerfile`
  (Deno + Hono) on an arm64 runner, pushes to ECR, and rolls the AWS ECS Express Mode service
  (Fargate-based, auto-provisions its own ALB with SSL termination, which mic capture's secure-context
  requirement makes non-optional). Credentials come from GitHub's OIDC provider, so there are no long-lived
  AWS keys in the repo.
- **Frontend:** `frontend` deployed to AWS Amplify Hosting, auto-builds on the same push, independently.
- **Not the deploy path:** `infra/aws/ecs-deploy.sh` *bootstraps* infrastructure — IAM roles, the S3 bucket,
  the service itself — and is a local, occasional, human-run thing. CI deliberately doesn't hold
  `iam:CreateRole`.
- **Verifying a deploy is live:** `GET /health` returns `{version: "<short sha>"}` — match it against
  `git rev-parse --short HEAD`. A 200 alone proves nothing: during a rollout both revisions answer. And
  don't smoke-test with `/polly/blocks/…` — a cache miss bills a synthesis and writes an S3 object.
- **Database:** CockroachDB Serverless. The cluster is connected to directly rather than provisioned from a
  script; schema changes go through `npm run db:migrate`.
- **Cost control:** an AWS Budget alert configured at a small dollar threshold from day one — this is an
  out-of-pocket build. `infra/aws/budget-alert.sh`, idempotent and re-runnable.

---

## Judging criteria — where to look

| Criterion | Where it shows up in this repo |
|---|---|
| Agentic Memory Design | `api` — the read-decide-act-write loop around `line_mastery` and `session_history`; multi-table serializable transactions on every session write |
| Technical Implementation | `infra/cockroachdb` — schema, migrations, and the vector columns the mistake-pattern search runs over; CockroachDB Cloud MCP Server used read-only in dev |
| Real-World Impact | See "What this is" above — the story this project is built around |
| Production Readiness | No client-side AWS keys, transaction retry logic, graceful degradation if Bedrock/Polly are slow, AWS Budget alert |
| Creativity & Originality | Memory here is a *skill/mastery model over time* — closer to spaced repetition for embodied performance than to chatbot fact-memory. See `docs/PROJECT_PLAN.md` §2. |

---

## Source text & licensing

Play text: Jon Bosak's Shakespeare XML (Moby Shakespeare text, placed in the public domain by Moby Lexical
Tools, 1992; SGML/XML markup by Jon Bosak, 1992–1998; freely copyable and distributable worldwide per the
source file's own header). Sourced from rufuspollock-okfn/shakespeare-material on GitHub.

---

## Where the docs are

`docs/` is where reasoning lives; read the relevant one before changing a subsystem.

| Doc | What it covers |
|---|---|
| `PROJECT_PLAN.md` | Architecture, data model, parsing rules, scope, cost |
| `OPEN_ITEMS.md` | What's knowingly unfinished, and what's already settled about it |
| `beats-and-blocks-plan.md` | The beat/block distinction and how the importer derives both |
| `polly-gen-issue.md` | Why the Polly engine is pinned to neural, and how bad renders survived an engine change |
| `BE_PLAN.md` / `FE_PLAN.md` / `API_PLAN.md` | Per-layer design |
| `ORCHESTRATION_PLAN.md` | Build sequencing and current status |
