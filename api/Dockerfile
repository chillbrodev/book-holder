FROM denoland/deno:2.9.4

# Matches the PORT the app binds to (clients/config-client/configClient.ts)
# and what ECS Express Mode's container port config should point at.
EXPOSE 8000

WORKDIR /app

# Transfer ownership of the (root-created) working directory to the `deno`
# user *before* copying anything in or switching to it, so every step below
# can safely run as non-root. Doing this out of order — e.g. `USER deno`
# before this chown — is exactly the setup that breaks `deno install` with
# "Permission denied (os error 13) (for '/app/deno.lock')", since `/app` is
# root-owned by default and the lockfile write has nowhere to land.
# See https://github.com/denoland/deno_docker/issues/537.
RUN chown deno:deno /app
USER deno

# Cache dependencies as their own layer (re-run only when deno.json/deno.lock
# change, not on every source edit below).
COPY --chown=deno:deno deno.json deno.lock ./
RUN deno install --frozen

# App source — copied with the right ownership directly, no follow-up chown.
COPY --chown=deno:deno . .

# Pre-compile so startup doesn't pay the type-check/compile cost on every
# container boot.
RUN deno cache src/main.ts

# Permission flags (including --allow-read=../.env — configClient.ts
# unconditionally tries to load a repo-root .env; loadSync() no-ops on a
# missing file, but the container needs the read *permission* granted or
# Deno throws before it even checks whether the file is there) live in the
# "production" task in deno.json, single source of truth shared with the
# other deno task entries rather than duplicated here.
CMD ["task", "production"]
