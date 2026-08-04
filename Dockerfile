# Multi-stage build: compile TypeScript in a full node_modules image, then
# ship only the compiled output + production dependencies. Runs the hosted
# HTTP API (bin/http-server.ts) by default - override CMD to run the CLI
# or MCP server instead.
#
# NOT included, on purpose, not silently assumed: any auth/gateway layer in
# front of the HTTP API (src/interfaces/http/server.ts has none - see its
# own file comment), TLS termination, or a wired-up Postgres backend for
# TaskAuthorizationManager (PostgresTaskStore exists and is tested against
# a real database, but is not yet the engine's storage backend - see
# docs/PIVOT_AUDIT.md). This image is deployment-shaped, not a finished
# production deployment.
#
# Verification status, stated plainly: `docker build` and `docker compose
# up --build` were both run live (2026-08-01) - the app container starts,
# serves a real POST /v1/tasks over the compose network, and successfully
# writes SCRIP_STORE/SCRIP_LEASE_STORE to the mounted /data volume. That
# last part failed the first time this was actually tried: a named volume
# with nothing at its mount path in the image is created root-owned, which
# the unprivileged `node` user this image runs as can't write to - fixed by
# pre-creating and chowning /data in the runtime stage below, before `USER
# node`. Postgres itself was not exercised through the app in this
# verification - TaskAuthorizationManager still doesn't read DATABASE_URL,
# so the postgres service in docker-compose.yml comes up healthy but
# unused by the app, same as before this verification pass.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scrip.yaml ./scrip.yaml
# /data is where docker-compose.yml mounts the scrip-data volume
# (SCRIP_STORE/SCRIP_LEASE_STORE both point there). A named volume with
# nothing at its mount path in the image gets created root-owned, which
# the unprivileged `node` user below can't write to - pre-creating and
# chowning it here is what makes Docker copy that ownership onto the
# volume the first time it's attached, instead of EACCES on first write.
RUN mkdir -p /data && chown -R node:node /app /data

# node:22-slim ships a built-in unprivileged "node" user (uid 1000) for
# exactly this - don't run the container as root.
USER node

EXPOSE 8787
CMD ["node", "dist/bin/http-server.js"]
