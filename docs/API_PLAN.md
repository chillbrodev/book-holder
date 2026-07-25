# API Plan — `api` (as built)

Companion to `PROJECT_PLAN.md` and `BE_PLAN.md`. Those two are the original plan and its status log; this
doc is a snapshot of `api`'s actual structure and conventions as built, kept current as it grows — read this
first to get oriented, then `BE_PLAN.md` for the fuller rationale/history behind decisions.

---

## 0. Status

**Built**: Deno + Hono runtime, `clients/` (config + DB), `errors/` (base error pattern), `features/app`
(composition root), `features/auth` (username + PIN auth, full register/login/logout/me flow, PIN lockout).
Dockerfile + `infra/aws/ecs-deploy.sh` exist and are verified but **not deployed** — deliberately holding off
until there's more to deploy (see `ORCHESTRATION_PLAN.md`).

**Not built**: any rehearsal-flow endpoints (play/role/scene picker, line playback, submission/comparison,
session write) — nothing past auth exists yet. No Bedrock/Polly/Transcribe/S3 wiring.

---

## 1. Runtime

- **Deno 2.9.4 + Hono**, not Node/Express. Hono pulled in via JSR (`jsr:@hono/hono`), not npm.
- **`deno.json` imports are explicit per-subpath**, not the wildcard `"hono/": "jsr:@hono/hono/"` form Hono's
  own docs show — that form fails to resolve in this Deno version against a package with ~100 exports
  (`Failed to resolve the specifier ... could not be URL-parsed`). Each subpath actually used
  (`hono/cors`, `hono/cookie`, `hono/http-exception`, `hono/utils/types`) is mapped individually instead.
- **`pg` (npm) via an `npm:` specifier** for CockroachDB access — same driver Node-side tooling
  (`packages/play-importer`, `infra/cockroachdb/migrate.ts`) uses, so query/pooling behavior is consistent
  across the repo.
- **`@std/dotenv`'s `loadSync`**, not Deno's native `--env-file` flag — a deliberate choice to match an
  established convention (env loading as a side-effecting import inside the config client itself, so it's
  self-contained regardless of how the script is invoked) over the flag-based alternative. Costs an extra
  `--allow-read` permission grant that `--env-file` wouldn't have needed.
- **Local dev**: `npm run dev` at the repo root (`concurrently` running `frontend`'s Vite dev server and
  `cd api && deno task dev` side by side). `api` is **not** an npm workspace — it has no `package.json`;
  `deno.json` is its own manifest.

### `deno.json` tasks

| Task | Command | Used for |
|---|---|---|
| `dev` | `deno run --watch --allow-net --allow-env --allow-read=../.env src/main.ts` | Local dev, auto-restart on change |
| `start` | same as `dev` minus `--watch` | Manual local run |
| `production` | same as `start` | **What the Dockerfile's `CMD` actually runs** (`["task", "production"]`) — single source of truth for prod permission flags instead of duplicating them in the Dockerfile |
| `test` | `deno test --allow-net --allow-env --allow-read=../.env` | `deno task test` |

`--allow-read=../.env` is granted in every task (including `production`) even though the container never has
that file — the permission *grant* is required before Deno will even check whether the file exists;
`loadSync` no-ops silently on a missing file once the grant is there. Omitting the flag crashes the app on
boot with a `NotCapable` error, not a graceful skip — this bit us once already (see `clients/config-client`
below), worth remembering before touching these tasks.

---

## 2. Directory structure

```
api/
├── Dockerfile
├── .dockerignore
├── deno.json / deno.lock
└── src/
    ├── main.ts                    # Deno.serve bootstrap only — no logic
    ├── types.ts                   # AppEnv: shared Hono<Variables> generic (cross-feature)
    ├── errors/
    │   └── base-error.ts          # BaseError<T>, isBaseError, baseErrorToResponse — generic, no feature knowledge
    ├── clients/                   # one folder per external integration
    │   ├── config-client/configClient.ts
    │   └── cockroach-db/dbClient.ts
    └── features/                  # one folder per feature/domain
        ├── app/
        │   ├── app.ts             # composition root: Hono instance, CORS, mounts, onError
        │   └── test/app.test.ts
        └── auth/
            ├── routes.ts          # thin — parse input, call service, format response, assume success
            ├── service.ts         # AuthService — all business logic lives here
            ├── middleware.ts      # sessionMiddleware
            ├── errors.ts          # AuthError (extends BaseError)
            ├── interfaces.ts      # AuthUser
            ├── pin.ts             # PBKDF2 hash/verify — pure, no DB
            ├── session-tokens.ts  # token generation/hashing — pure, no DB
            └── test/
                ├── routes.test.ts          # fakes AuthService, checks HTTP wiring only
                ├── service.test.ts         # real validation logic, no DB
                ├── pin.test.ts
                └── session-tokens.test.ts
```

**Conventions**, all deliberate choices made while building this out:
- **No `<feature>.` filename prefix** inside a feature folder (`routes.ts`, not `auth.routes.ts`) — the folder
  already namespaces it. (The prefixed style is real — it's NestJS's own generator convention, mainly earning
  its keep for editor-tab disambiguation across many similarly-named files — but not worth it at this repo's
  scale.)
- **Tests live in a `test/` subfolder per feature**, not co-located next to the source file.
- **`*.test.ts`**, not Deno's other supported convention `*_test.ts`. (Deno's default test discovery picks up
  both, and also finds `.test.ts` files nested in a `test/` subfolder with zero extra `deno.json` config —
  confirmed directly, not assumed.)
- **`clients/` vs `features/`**: a client wraps an external system (CockroachDB, and later Bedrock/Polly/
  Transcribe/S3) and knows nothing about app features. A feature owns HTTP surface + business logic for one
  domain and calls into clients. `errors/base-error.ts` is a third category — shared infrastructure with no
  feature or external-system knowledge — so it isn't nested under either.

---

## 3. `clients/` — external integrations

### `config-client/configClient.ts`

Single source of truth for env-derived config, grouped by domain, not one flat list:

```ts
ConfigClient.Server.env / .isDev / .isProduction / .port
ConfigClient.CockroachDb.url
ConfigClient.Auth.sessionCookieName / .allowedOrigin / .sessionTtlDays
```

- `getDenoEnvValueOrThrow` — required vars fail loudly at import time (`*** ALERT *** Missing ENV: X`, in
  red/bold). `CockroachDb.url` is the only one using this today.
- `getDenoEnvValueOrDefault` — optional vars fall back to a sane default (`PORT` → 8000, `DENO_ENV` → `local`,
  `ALLOWED_ORIGIN` → `http://localhost:5173`, `SESSION_TTL_DAYS` → 30).
- Loads `../.env` (repo root — shared with `migrate.ts`/`play-importer`, same `COCKROACHDB_URL`) via
  `@std/dotenv`'s `loadSync` as an import-time side effect. Resolves correctly both in local dev (`deno task`
  sets CWD to `api/`) and in the Docker image (`WORKDIR /app` mirrors `api/`) — in the container the file
  doesn't exist and `loadSync` just no-ops, real values come from the ECS task definition's environment.

### `cockroach-db/dbClient.ts`

`DbClient.getPool()` — lazy-singleton `pg.Pool`, reads `ConfigClient.CockroachDb.url`. Same lazy-init pattern
as `packages/play-importer/src/db.ts`'s `getPool()`.

---

## 4. `errors/base-error.ts` — the error pattern

```ts
export class BaseError<T extends string> extends Error {
  // name: T — a per-domain string-literal union, not a generic string
  // statusCode: explicit override, else looked up by name in nameToErrorCodeLookup, else defaultStatusCode (500)
  // cause, context (structured data for future error-tracking, not sent to the client), skipReporting
}

export function isBaseError(err: unknown): err is BaseError<string>
export function baseErrorToResponse<T extends string>(error: BaseError<T>): Response
```

Every feature-specific error class extends `BaseError<ItsOwnNameUnion>` and overrides `nameToErrorCodeLookup`
rather than hardcoding a status per subclass. `features/auth/errors.ts` is the only one so far:

```ts
type AuthErrorName = "VALIDATION_ERROR" | "INVALID_CREDENTIALS" | "UNAUTHENTICATED" | "ACCOUNT_LOCKED" | "USERNAME_TAKEN";
class AuthError extends BaseError<AuthErrorName> { /* nameToErrorCodeLookup: 400/401/401/423/409 */ }
```

`app.ts`'s single `onError` handler is the only place that translates a thrown error into an HTTP response:
`isBaseError` → `baseErrorToResponse` (→ `{ error: { name, msg } }` + the resolved status); `HTTPException` →
its own `getResponse()`; anything else → logged to stderr (no error-tracking service wired up yet — this is
where that call would go, gated on `skipReporting`) and a generic 500.

**Note**: `context` (e.g. `ACCOUNT_LOCKED`'s `retryAfterSeconds`) is *not* serialized into the client response
— `baseErrorToResponse` only sends `name`/`msg`. It's meant for future error-tracking/observability, not the
API contract. Right now `retryAfterSeconds` is folded into the human-readable message string instead
(`"Try again in 900 seconds."`) since there's nowhere else for it to surface. If the frontend ever wants it
as a structured field (e.g. to drive a countdown), that needs a deliberate exception to this rule, not an
assumption that `context` reaches the client.

---

## 5. `features/app` — composition root

`app.ts` is the only place that: creates the `Hono<AppEnv>` instance, applies CORS
(`ConfigClient.Auth.allowedOrigin`, `credentials: true`), mounts `GET /`, `GET /health`, and
`app.route("/auth", authRoutes)`, and registers `onError`. `main.ts` imports `app` and does nothing but
`Deno.serve` — no logic lives there.

---

## 6. `features/auth` — username + PIN auth

Schema: `infra/cockroachdb/migrations/002_pin_auth.sql` (`users.username`/`pin_hash`/`failed_pin_attempts`/
`locked_until`, plus a standalone `auth_sessions` table).

### Service-first, thin routes

**`service.ts` (`AuthService`) owns all business logic** — validation, PIN hashing/verification, lockout
counting, unique-username handling, session issuance. **`routes.ts` is thin**: parse the body, call the
service, set the cookie, return the response — no branching on failure anywhere. Thrown `AuthError`s just
propagate to `app.ts`'s `onError`; routes assume success.

`AuthService` is a plain exported object (same shape as `ConfigClient`/`DbClient`), which is what makes
`routes.test.ts` able to fake it directly — swap a method (`AuthService.register = () => fakePromise`) for
the duration of a test, restore it in a `finally`. No DI framework, no mocking library. `routes.test.ts` only
verifies HTTP wiring (status codes, `set-cookie`, response shape) against a faked service; `service.test.ts`
exercises the real validation logic (still without a DB — see §8).

### Endpoints

| Method + path | Auth required | What happens |
|---|---|---|
| `POST /auth/register` | no | Validate → hash PIN → insert `users` row → issue session immediately (no separate login step) |
| `POST /auth/login` | no | Look up by username → check lockout → verify PIN → issue session, or record a failed attempt |
| `POST /auth/logout` | no (reads cookie if present) | Delete the matching `auth_sessions` row, clear the cookie |
| `GET /auth/me` | yes (`sessionMiddleware`) | Return the current session's user |

### Session mechanics

- A random 32-byte token is generated per login/register; **only its SHA-256 hash** is stored
  (`auth_sessions.token_hash`) — a leaked/dumped table alone can't be replayed as a live session.
- The raw token is set as an `httpOnly` cookie (`book_holder_session`).
- `secure`/`sameSite` are keyed off `ConfigClient.Server.isProduction`: `Secure` + `SameSite=None` in
  production (frontend on Amplify, API on ECS are different origins — cross-site cookies require this
  combination), `SameSite=Lax` and no `Secure` in local dev.
- **Session length: 30 days** (`SESSION_TTL_DAYS`, `ConfigClient.Auth.sessionTtlDays`) — a fixed window from
  login (cookie `maxAge` and `auth_sessions.expires_at` both set at issuance), not a sliding/refreshing one.
  Deliberately long given the single-user, infrequent-session usage pattern; configurable via env var.
- `sessionMiddleware` (used by `/auth/me`, and any future protected route) hashes the cookie token and checks
  `auth_sessions JOIN users WHERE token_hash = ? AND expires_at > now()` — missing, expired, or logged-out
  all fail the same way (401 `UNAUTHENTICATED`).
- **PIN lockout**: 5 wrong PINs in a row locks the account for 15 minutes (`MAX_FAILED_ATTEMPTS`,
  `LOCKOUT_MINUTES` in `service.ts`); a correct PIN resets the counter. Two real bugs were caught building
  this against the live DB, not just unit tests — worth knowing if this code is touched again:
  - CockroachDB's `INT` is 64-bit, so `pg` returns `failed_pin_attempts` as a **string**; `+ 1` on it
    silently string-concatenates instead of adding. Needs an explicit `Number(...)`.
  - `locked_until = now() + ($2 * interval '1 minute')` fails outright — CockroachDB can't infer `$2`'s type
    and throws `unsupported binary operator: <interval> * <interval>`. Needs `$2::INT`.
- **Not built**: session revocation on PIN change, "log out all devices," any admin/multi-session view — not
  a concern at this scale, but genuinely absent, not just undocumented.

---

## 7. Testing conventions

- `deno task test` = `deno test --allow-net --allow-env --allow-read=../.env`.
- **Pure logic** (`pin.ts`, `session-tokens.ts`) — tested directly, no DB, no HTTP.
- **Service validation paths** (`service.test.ts`) — real `AuthService` calls that throw before ever reaching
  `DbClient.getPool()` (missing/malformed input). Safe without a live database.
- **Route wiring** (`routes.test.ts`) — `AuthService` faked, verifies status codes / cookies / response shape
  via `app.request()`, not a running server.
- **Deliberately not automated**: the DB-touching success paths (real register/login/lockout-triggering
  against CockroachDB). These were verified manually against the real dev cluster during development (with
  disposable test users cleaned up immediately after) rather than wired into `deno task test`, to avoid
  writing test data into the shared hackathon cluster on every run. If a dedicated test database ever exists,
  this is the first thing to automate.

---

## 8. Deployment (built, not yet run)

- `Dockerfile` — `denoland/deno:2.9.4` base, runs as the non-root `deno` user for the whole build (not just
  runtime) by `chown`ing `/app` before `deno install`/copying source in — works around
  [denoland/deno_docker#537](https://github.com/denoland/deno_docker/issues/537) (installing as root then
  switching users right before `CMD` avoids the bug too, but loses non-root's least-privilege benefit during
  dependency resolution). `deno install --frozen` fails the build loudly on lockfile drift. `CMD ["task", "production"]`.
- `infra/aws/ecs-deploy.sh` — idempotent (same pattern as `budget-alert.sh`): builds the image, pushes to
  ECR, creates the IAM roles, creates-or-updates an **ECS Express Mode** service (AWS's current recommended
  App Runner replacement — App Runner stopped accepting new customers 2026-04-30).
- **Neither has been run.** Deliberately holding off until there's a real rehearsal-flow endpoint to deploy,
  not just auth — see `ORCHESTRATION_PLAN.md`. Full cost breakdown: `PROJECT_PLAN.md` §9.

---

## 9. Env vars (`api`-relevant subset of `.env.example`)

```
COCKROACHDB_URL=          # required — throws at import time if unset
PORT=                     # default 8000
DENO_ENV=                 # "production" tightens cookie flags; anything else (incl. unset) = local dev
ALLOWED_ORIGIN=           # default http://localhost:5173 (Vite) — CORS origin allowed to send credentialed requests
SESSION_TTL_DAYS=         # default 30
```
