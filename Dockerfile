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
# Verification status, stated plainly: every file this Dockerfile
# references (package.json, package-lock.json, scrip.yaml,
# dist/bin/http-server.js) was confirmed to exist and the underlying
# `node dist/bin/http-server.js` command was run directly and verified live
# against real Ramp (see the commit that fixed dist/'s missing
# schema.sql/model_price.json). The Dockerfile itself has NOT been run
# through `docker build` - no Docker daemon was reachable in this
# environment. Build and run it yourself before trusting the image boundary
# specifically; the command it runs is real and tested, the container
# wrapper around it is not yet.

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
RUN chown -R node:node /app

# node:22-slim ships a built-in unprivileged "node" user (uid 1000) for
# exactly this - don't run the container as root.
USER node

EXPOSE 8787
CMD ["node", "dist/bin/http-server.js"]
