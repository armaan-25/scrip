# Scrip — extended work-session ledger

Last updated: 2026-08-01T07:35Z

Repository: `armaan-25/scrip` (local path `/Users/armaan/Downloads/Projects/spending`)
Branch: `main`
Commit at session start: `f868a7bc423eb9d2d5dfec77296c21ee6a711474`
No staging URL — this is a backend/CLI/MCP project with no hosted environment; all
verification below is local (in-process tests, a local Postgres instance, and a
local Docker daemon).

Test accounts: none — this project has no user-facing auth. Real external
credentials involved: `RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` (sandbox,
`demo-api.ramp.com`), `ANTHROPIC_API_KEY` — both already present in `.env`
from prior sessions, values never printed here.

## Scope of this session

User ask: "work for a few hours, build out remaining gaps and polish frontend,
get back to me with an audit." This repo has no web frontend — "frontend"
here is `visuals/` (untracked local HTML/SSE demo dashboards). "Remaining
gaps" are the items README.md and ARCHITECTURE.md's own "Designed but not
yet built" / "Known gaps" sections already named.

## Checklist and status

- [x] Baseline regression: `tsc --noEmit`, `npm test`, `npm run build` — all
      clean before any change.
- [x] `scripts/demo-flagship.ts` regression — deterministic, no API key,
      same 3-of-4-workers/denied-worker outcome as documented.
- [x] Audit existing `visuals/` pages (`agents-live.html`, `agents-real.html`,
      `receipt-live.html`) — ran each against its real backend, confirmed
      every SSE/HTTP field the JS reads matches what the backend actually
      returns. No bugs found.
- [x] Build `visuals/agent-card-live.html` + `agent-card-live-server.ts` —
      the one feature (`reserveCardPurchase`/Agent Cards, built in the prior
      session) with no visualization. Verified end-to-end.
- [x] Live-verify `PostgresTaskStore` against a real database.
- [x] Close the "no crash recovery/expiry-cleanup daemon" gap:
      `TaskAuthorizationManager.sweepExpired()` + `scrip task sweep-expired`.
- [x] Live-verify `Dockerfile`/`docker-compose.yml` via a real Docker daemon —
      found and fixed a real bug in the process.
- [ ] Wire `PostgresTaskStore` in as `TaskAuthorizationManager`'s backend —
      **not attempted**, see "Deliberately not attempted" below.
- [ ] Auth/gateway layer in front of the HTTP API — **not attempted**, same
      reason.
- [ ] Idempotency-key support in the CLI/HTTP/MCP surfaces (Postgres already
      has it) — **not attempted**, same reason.
- [ ] Live-verify `GithubPrOutcomeVerifier` — **blocked**, needs a real
      `GITHUB_TOKEN`.
- [ ] Live-verify `RampAgentCardIssuer` — **blocked**, needs `cards:write`
      scope approval on the Ramp sandbox app + a real cardholder user ID.

## Findings

### P1 — `docker compose up` could not actually start the app (fixed)

- **Where:** `Dockerfile` runtime stage, `docker-compose.yml`'s `app` service
  mounting the `scrip-data` volume at `/data`.
- **Precondition:** `docker compose up --build` from a clean state (no prior
  volume).
- **Expected:** the `app` container starts and serves `POST /v1/tasks`.
- **Actual (before fix):** `app-1` crashed on startup:
  ```
  Error: EACCES: permission denied, open '/data/ramp.json'
      at Object.writeFileSync (node:fs:2430:20)
      at LocalReceiptStore.save (file:///app/dist/src/store.js:32:12)
  ```
- **Root cause:** Docker creates a named volume with nothing at its image
  mount path as root-owned. The image runs as the unprivileged `node` user
  (added deliberately for a Docker security lint, see `docs/PIVOT_AUDIT.md`
  §12) — that user has no write access to a root-owned `/data`.
- **Fix:** `Dockerfile` — added `RUN mkdir -p /data && chown -R node:node
  /app /data` before `USER node`, so Docker copies the correct ownership
  onto the volume the first time it's attached.
- **Regression evidence:** `docker compose down -v` (clean slate) →
  `docker compose up -d --build` → both containers `Up`/`healthy` →
  `curl -X POST http://localhost:8787/v1/tasks ...` returned a real
  authorization JSON → `docker compose exec app cat /data/ramp.json`
  confirmed the write actually landed on the volume. Torn down cleanly
  afterward (`docker compose down -v`, test image removed); the
  pre-existing unrelated `browser-swarms-postgres-1` container was left
  untouched throughout.
- **Docs updated:** `Dockerfile` header comment, `README.md`, `ARCHITECTURE.md`,
  `docs/PIVOT_AUDIT.md` §13.

### P3 — none found beyond the above

The three pre-existing `visuals/*.html` pages and their SSE/HTTP contracts
were all confirmed correct on first inspection — no bugs found in any of
them. `demo-flagship.ts`, the CLI, and the full test suite all passed
before any change was made this session.

## Fixes attempted and retest results

| Gap | Action | Result |
|---|---|---|
| "No crash recovery/expiry-cleanup daemon" | Added `TaskAuthorizationManager.sweepExpired()` (`src/lease.ts`), `scrip task sweep-expired` CLI verb (`src/cli.ts`, `src/handlers.ts`) | 3 new unit tests in `tests/lease.test.ts`, 1 new CLI test in `tests/cli.test.ts` — all pass. Full suite 148/148. |
| "Dockerfile never run through `docker build`" | Ran `docker build`, found+fixed the `/data` permission bug, re-ran `docker build` + `docker compose up --build` | Both succeed; real HTTP request served from inside the compose network; volume write confirmed. |
| "PostgresTaskStore live-verification" (already claimed done in a prior session) | Restarted the project's local ephemeral Postgres 14 instance (`.pgdata-dev/`, was shut down), re-ran `tests/postgres-task-store.test.ts` | Re-confirmed: 8/8 pass against a real live database, including the two-connection race test. |
| Missing visualization for `reserveCardPurchase()`/Agent Cards | Built `visuals/agent-card-live.html` + `visuals/agent-card-live-server.ts` | SSE stream verified end-to-end against real `TaskAuthorizationManager.reserveCardPurchase()` code (with `MockCardIssuer`, since no real cardholder is configured). |

## Deliberately not attempted this session

Three items remain in every doc's "known gaps" list, unchanged, on purpose:

1. **Wiring `PostgresTaskStore` in as `TaskAuthorizationManager`'s backend.**
   The manager's public API is synchronous and used throughout the CLI, MCP
   server, and HTTP server; making it Postgres-backed means an async API
   change touching every caller. `docs/PIVOT_AUDIT.md` already flags this as
   "a real, separate integration decision," not a bug — attempting a
   whole-codebase refactor autonomously, unsupervised, risked large-blast-
   radius regressions for a decision that deserves a design conversation
   first.
2. **An auth/gateway layer in front of the HTTP API.** This needs a product
   decision on the auth model (API keys? mTLS? something Ramp-specific?)
   before any code — not a place to guess.
3. **Idempotency-key support outside `PostgresTaskStore`.** Moderate scope,
   touches three surfaces (CLI, HTTP, MCP) and depends partly on decision
   #1 (an in-memory idempotency table doesn't carry the same guarantee a
   real caller would expect).

## Unresolved human actions, in order

1. **Ramp Agent Card live verification** — add `cards:write` scope to the
   "Scrip" sandbox app in the Ramp Developer Console, find/create a real
   cardholder user ID, set `RAMP_CARDHOLDER_USER_ID` in `.env`, then run
   `npx tsx scripts/smoke-test-agent-card.ts`. Expect it to either succeed
   or return a real error that pinpoints which field name in
   `src/ramp-agent-card.ts` needs correcting.
2. **GitHub PR outcome verifier live verification** — set a real
   `GITHUB_TOKEN` and exercise `GithubPrOutcomeVerifier` against a real PR.
3. **Design conversation on the three "deliberately not attempted" items
   above**, in priority order: Postgres wiring first (it's the one that
   makes the durable-persistence story end-to-end), then HTTP auth, then
   idempotency keys.

## Next three actions

1. Open `visuals/agent-card-live.html` in an actual browser (`npx tsx
   visuals/agent-card-live-server.ts`, then visit `http://localhost:8799`)
   to confirm the visual polish reads well — this session verified the
   data contract, not the rendered animation.
2. Decide whether to pursue the Postgres-backend wiring now (with a design
   session first) or leave `TaskAuthorizationManager` in-memory/JSON-file
   for the near term.
3. Chase the two blocked live-verifications (Agent Card, GitHub PR
   verifier) when the relevant credentials/scopes are available.
