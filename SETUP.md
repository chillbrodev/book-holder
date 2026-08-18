# Setup, and running it

Everything needed to get The Book Holder running locally and deployed. The
project description, the agentic design and the reasoning behind the technical
choices live in [`README.md`](README.md); this file is the operational half.

---

## Running it locally

### Prerequisites

| Need | Why | Check |
|---|---|---|
| **Node ≥ 20** | frontend, importer, migrator | `node -v` |
| **Deno ≥ 2** | `api/` is Deno, and `npm run dev` shells out to `deno task dev` | `deno --version` |
| **A CockroachDB cluster** | the memory layer. A free Serverless cluster from the [Cloud Console](https://cockroachlabs.cloud/) is plenty | |
| **A Supabase project** | sign-in only, no data lives there. Free tier. Enable **Email** under Authentication → Providers; nothing else needs turning on | |
| **An AWS account** | Polly, Transcribe and Bedrock are all server-side. There is no offline mode | `aws sts get-caller-identity` |
| **An S3 bucket** | the Polly cache. `infra/aws/ecs-deploy.sh` creates one, or make it by hand | |

Deno is the one that bites. Everything else fails at the step that needs it, while a missing Deno surfaces at the *last* step, inside a `concurrently` pane where it is easy to misread as the frontend being broken.

Supabase needs three values, and they are not interchangeable: the project URL goes in **both** `api/.env` (`SUPABASE_URL`) and `frontend/.env` (`VITE_SUPABASE_URL`), and the frontend also needs the **publishable** key (`VITE_SUPABASE_KEY`), never the `sb_secret_…` one, which would ship admin access to every visitor in the bundle. The API needs no Supabase key at all: it verifies tokens against the project's published JWKS, which is a public-key operation.

`./infra/aws/create-dev-user.sh` provisions a scoped IAM user granting exactly what this app calls. The AWS SDK cannot consume an `aws login` session, so a permanent key really is needed locally.

### Setup

```bash
git clone <repo-url> book-holder
cd book-holder
npm install

cp api/.env.example api/.env            # six values are required; the file marks which
cp frontend/.env.example frontend/.env  # the Supabase project the browser signs in against

npm run db:migrate                                    # migrations, in order
npm run import:play -- --play merry_wives_of_windsor  # parse XML, seed CockroachDB
npm run dev                                           # frontend + api together
```

`--dry-run` renders the parse to `packages/play-importer/output/<slug>/` and writes nothing, which is worth doing first when the parser changed. `--file <path>` reads local XML instead of fetching. The importer refuses to import a play that already exists.

**A fresh install has an empty audio cache**, so the first time you hear any speech it is synthesized from Polly and written to S3: real, billable, and slow on that one request, then instant and free forever after. Nothing re-renders on its own.

**Each side has its own `.env`**: `api/.env` and `frontend/.env`, with no repo-root file. Vite reads `frontend/.env` and nothing else, so the API's `SUPABASE_URL` is invisible to it. `VITE_API_BASE_URL` still defaults to `http://localhost:8000`, but `VITE_SUPABASE_URL`/`VITE_SUPABASE_KEY` have no defaults and the app throws on load without them. They must name the **same** Supabase project as the API's `SUPABASE_URL`; two different projects fail as a sign-in that appears to work followed by a 401 on everything.

### Day-to-day

```bash
cd api && deno task dev      # watch mode          (Deno, not npm)
cd api && deno task test     # API tests
cd api && deno fmt src/      # format, CI-relevant
cd frontend && npx tsc -b    # typecheck
cd frontend && npx oxlint    # lint
```

`api/.env` is the API's own file. `deno task` sets CWD to `api/`, which is why the tasks grant `--allow-read=.env`. The migrator and the importer read it too, by explicit path, so `COCKROACHDB_URL` lives in exactly one place. No AWS keys ever reach the frontend; every Bedrock, Polly, Transcribe and S3 call routes through `api/`.

---

## Deploying

Both halves deploy off a push to `main`. There is no manual step.

**Backend.** A push touching `api/**` runs `.github/workflows/deploy-api.yml`: build arm64, push to ECR, roll the ECS Express service. Credentials come from GitHub OIDC, so no long-lived AWS keys exist in the repo.

**Frontend.** Amplify builds off the same push, independently.

**Not the deploy path.** `infra/aws/ecs-deploy.sh` *bootstraps* infrastructure (IAM roles, the S3 bucket, the service itself) and is a local, occasional, human-run thing. It stays because it is the only path that stands this up from nothing, and because CI deliberately holds no `iam:CreateRole`.

**Verifying a deploy.** `GET /health` returns `{version: "<short sha>"}`. Match it against `git rev-parse --short HEAD`. **A 200 alone proves nothing**, because during a rollout both revisions answer, so a status check passes instantly and tells you nothing. The workflow now polls for the SHA itself rather than trusting a green check. The most recent deploy took 22 attempts across roughly five minutes before the old revision stopped answering.

Do not smoke-test with `/polly/blocks/…`. A cache miss bills a synthesis and writes an S3 object.

**Dev and production share one database**, which is why every migration is additive and `IF NOT EXISTS`.

---

## Where to go next

- [`README.md`](README.md): what this is, how the memory loop works, and why each
  decision was made
- [`CLAUDE.md`](CLAUDE.md): the conventions and the traps, written for whoever
  works on this next
- [`docs/`](docs/): one design doc per subsystem, each carrying its reasoning
