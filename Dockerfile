# Container image for the only supported production topology: one long-running
# Node process with a persistent volume (docs/sandbox-deployment.md). The
# serverless path (§11) is a sandbox demo and does not use this image.
#
# The pre-deploy posture gate (`npm run secrets:gate`) runs inside this build,
# before TypeScript is compiled, so an image cannot be produced from a missing,
# weak, placeholder or duplicated deployment value. The four values arrive as
# BuildKit secrets, never as build arguments or ENV: a build arg is recorded in
# the image history and an ENV is readable from the image, so either would
# defeat the point of checking them.
#
# Build with scripts/build-docker-image.sh, which supplies the secrets and
# forces the gate stage to run. BuildKit does not include secret contents in its
# cache key, so without `--no-cache-filter posture-gate` a cached layer could
# vouch for a previous build's values and let the current ones through unchecked.
#
# Requires a Docker installation with BuildKit and the buildx plugin (for the
# cache exclusion); scripts/build-docker-image.sh checks for the plugin rather
# than silently building without it.

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Dependencies from the lockfile only, so editing src/ does not reinstall.
COPY package.json package-lock.json ./
RUN npm ci

# The gate needs the TypeScript sources and dev dependencies (ts-node), not the
# compiled output. A separate stage lets the build wrapper exclude just this
# stage from the cache.
FROM deps AS posture-gate
COPY tsconfig.json ./
COPY src ./src

RUN --mount=type=secret,id=admin_api_key \
    --mount=type=secret,id=record_encryption_key \
    --mount=type=secret,id=llm_api_key \
    --mount=type=secret,id=texas_license_number \
    SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"; \
    for id in admin_api_key record_encryption_key llm_api_key texas_license_number; do \
      if [ ! -s "$SECRETS_DIR/$id" ]; then \
        echo "ERROR: build secret '$id' is required." >&2; \
        echo "The posture gate runs during the build: supply all four with --secret id=$id,env=<VAR> (scripts/build-docker-image.sh does this)." >&2; \
        exit 1; \
      fi; \
    done; \
    ADMIN_API_KEY="$(cat "$SECRETS_DIR/admin_api_key")" \
    RECORD_ENCRYPTION_KEY="$(cat "$SECRETS_DIR/record_encryption_key")" \
    LLM_API_KEY="$(cat "$SECRETS_DIR/llm_api_key")" \
    TEXAS_LICENSE_NUMBER="$(cat "$SECRETS_DIR/texas_license_number")" \
    npm run secrets:gate

FROM posture-gate AS build
COPY public ./public
# Drop dev dependencies only after the build; the gate stage above needs them.
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Record logs default to ./data; a mounted volume must be writable by the
# unprivileged user the app runs as.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
