# 📖 The Book Holder

*A rehearsal partner with a memory, for actors without a scene partner on demand.*

Built for the **CockroachDB × AWS Hackathon — Build with Agentic Memory** (submission deadline: August 18, 2026).

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

- Before a session: the agent reads her per-line mastery scores for the chosen scene and decides what to emphasize.
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
    ├── apps/
    │   ├── web/                 # React + Vite frontend — picker, rehearsal UI, playback
    │   └── api/                 # Node/Express backend — the rehearsal agent, deployed on AWS App Runner
    ├── packages/
    │   ├── shared-types/        # TypeScript types shared between web and api
    │   └── play-importer/       # Parses Moby Shakespeare XML and loads it into CockroachDB
    ├── infra/
    │   ├── cockroachdb/         # Schema migrations, ccloud CLI provisioning script
    │   └── aws/                 # App Runner + Amplify config, budget alert setup notes
    ├── docs/
    │   └── PROJECT_PLAN.md      # Full architecture, data model, judging-criteria mapping, timeline
    ├── .env.example
    ├── package.json             # npm workspaces root
    └── README.md                # this file

Uses **npm workspaces** (not pnpm/turborepo) — deliberately the simplest option that does the job, since this
is a solo, out-of-pocket, time-boxed build and there's no benefit to learning new tooling for its own sake.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, TypeScript | Fast local dev, simple deploys |
| UI components | [HeroUI](https://heroui.com) (React Aria + Tailwind v4) | Accessible structural chrome (pickers, modals, buttons); the rehearsal surface itself is hand-built for the Shakespearean identity |
| Frontend hosting | AWS Amplify Hosting | Connects to this repo, auto-builds `apps/web` on push |
| Backend | Node/Express | The rehearsal agent's API layer |
| Backend hosting | AWS App Runner | Autoscaling HTTPS, minimal new-service surface area to learn |
| Database | CockroachDB Serverless | Memory layer: sessions, line mastery, mistake embeddings, all transactional |
| LLM | Amazon Bedrock — Nova Micro/Lite (per-line comparison), a stronger model (session summaries) | Cost-scaled to call frequency |
| Voice | Amazon Polly (neural voices, one per character, cached per line) | |
| Listening | Amazon Transcribe (post-utterance, not streaming) | Live STT cut for time/risk — stretch goal |
| Recordings | Amazon S3 | Session playback |

---

## Getting started (local dev)

    git clone <repo-url> book-holder
    cd book-holder
    npm install

    cp .env.example .env
    # fill in CockroachDB connection string, AWS credentials, Bedrock model IDs — see below

    npm run import:play -- --play "merry_wives_of_windsor"   # parses XML, seeds CockroachDB
    npm run dev                                               # runs apps/web and apps/api together

### Environment variables (`.env`)

    COCKROACHDB_URL=              # from CockroachDB Cloud Console / ccloud CLI script in infra/cockroachdb
    AWS_REGION=
    AWS_ACCESS_KEY_ID=            # backend only — never exposed to the client
    AWS_SECRET_ACCESS_KEY=
    BEDROCK_MODEL_ID_COMPARISON=  # cheap model, per-line comparison (e.g. Nova Micro/Lite)
    BEDROCK_MODEL_ID_SUMMARY=     # stronger model, infrequent session summaries
    S3_RECORDINGS_BUCKET=
    POLLY_VOICE_MAP=              # character -> Polly voice ID mapping, see apps/api/config

No AWS keys are ever present in `apps/web` — all Bedrock/Polly/Transcribe/S3 calls route through `apps/api`.

---

## Data model

Scoped to one play (*Merry Wives of Windsor*) but structured so a second play is a data-import task, not a
schema change. Full detail, including the play-XML parsing rules, is in `docs/PROJECT_PLAN.md` (§5).

    plays, characters, lines (vector embedding per line)
    users, roles_in_progress
    session_history
    line_mastery        -- read before a session, written after, in one serializable transaction
    mistake_log          -- vector embedding per mistake, feeds nearest-neighbor pattern search
    recordings

---

## Deployment

- **Database:** CockroachDB Serverless cluster, provisioned via the ccloud CLI script in `infra/cockroachdb/`
  (scripted, not manual clicks — a judged production-readiness signal, not boilerplate).
- **Backend:** `apps/api` deployed to AWS App Runner, repo-connected, autoscaling, HTTPS by default.
- **Frontend:** `apps/web` deployed to AWS Amplify Hosting, auto-builds on push to `main`.
- **Cost control:** an AWS Budget alert configured at a small dollar threshold from day one — this is an
  out-of-pocket build.

---

## Judging criteria — where to look

| Criterion | Where it shows up in this repo |
|---|---|
| Agentic Memory Design | `apps/api` — the read-decide-act-write loop around `line_mastery` and `session_history`; multi-table serializable transactions on every session write |
| Technical Implementation | `packages/play-importer` (vector embeddings), `infra/cockroachdb` (ccloud CLI, MCP Server used read-only in dev) |
| Real-World Impact | See "What this is" above — the story this project is built around |
| Production Readiness | No client-side AWS keys, transaction retry logic, graceful degradation if Bedrock/Polly are slow, AWS Budget alert |
| Creativity & Originality | Memory here is a *skill/mastery model over time* — closer to spaced repetition for embodied performance than to chatbot fact-memory. See `docs/PROJECT_PLAN.md` §2. |

---

## Source text & licensing

Play text: Jon Bosak's Shakespeare XML (Moby Shakespeare text, placed in the public domain by Moby Lexical
Tools, 1992; SGML/XML markup by Jon Bosak, 1992–1998; freely copyable and distributable worldwide per the
source file's own header). Sourced from rufuspollock-okfn/shakespeare-material on GitHub.

---

## Status / roadmap

- [ ] Week 1 — CockroachDB schema + ccloud provisioning, play importer, basic picker UI, Amplify + App Runner deployed end-to-end
- [ ] Week 2 — Polly voices, record-and-compare rehearsal flow, transactional session writes, first Bedrock coaching call, S3 recordings
- [ ] Week 3 (buffer) — vector-search mistake-pattern coaching, retry/degradation paths, Shakespearean visual pass, demo video

See `docs/PROJECT_PLAN.md` for the full week-by-week plan.
