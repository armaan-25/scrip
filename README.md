# Scrip

> Scrip authorizes, meters, and settles autonomous work.

Ramp governs company money. Scrip governs the execution spending it.

Or plainly: Ramp budgets teams, agents, and purchases. Scrip budgets one
live job across all of its workers and resources.

```text
Company budget
      ↓
Scrip task execution contract
      ↓
reserve / delegate / commit / release / revoke
      ↓
models / paid tools / compute / purchases / humans
      ↓
verified outcome
      ↓
one economic receipt
```

The core unit isn't an inference request. It's an autonomous task — one
job that may spawn concurrent workers, call multiple model providers,
hit paid APIs, and needs its full economics settled against a verified
outcome, not just a token count.

## The durable wedge

Transactional cost isolation for autonomous execution trees, followed by
outcome-backed settlement:

1. One job receives an execution allowance.
2. The job may spawn concurrent workers.
3. Workers receive attenuated portions of the parent's authority — never
   more than the parent has genuinely left.
4. Every costly action reserves resources before execution.
5. Concurrent workers cannot spend the same remaining allowance — the
   reservation math (`available = allowance - spent - pending -
   delegated`) is atomic, not a race.
6. Actual usage replaces the reservation; unused capacity is released.
7. Revoking the task revokes its full execution tree.
8. The complete job settles against verified evidence of success or
   failure, not the worker's own narrative.

`scripts/demo-flagship.ts` proves this end to end, deterministically, no
API key required: one task, four concurrent workers (two dispatching
inference to different model providers, one making a non-inference paid
call, one intentionally denied by the atomic reservation math before any
provider call), unused capacity released, a real outcome verification
call, one settled receipt.

## What's actually built vs. designed vs. future

Being specific about this matters more than sounding finished. Three
tiers:

**Built, tested, and live-verified against real external services:**
Ramp OAuth (client-credentials), real Ramp Fund balance reads, real
broadcast to Ramp's AI Usage Tracking, real Anthropic and OpenAI
inference dispatch, the CLI's full task/action/receipt lifecycle over
separate processes, the MCP server over a real protocol round-trip, the
hosted HTTP API (real TCP requests, real Bearer auth, real status-code
semantics — 401/402/403/404 mapped from real error types, not just 200s),
and a real concurrency-safe Postgres store (`PostgresTaskStore` — atomic
`reserveAction` via row-level locking, idempotency-key-safe retries,
proven with a live test that races two connections for the same
remaining balance and asserts exactly one wins).

**Built and tested, not yet live-verified against a real external
service:** `GithubPrOutcomeVerifier` (real GitHub REST API shapes,
confirmed against GitHub's own docs, but only unit-tested against a fake
`fetch` — no `GITHUB_TOKEN` configured in this environment yet).

**Built, not yet integrated:** `PostgresTaskStore` proves the durable,
cross-process-safe mechanism for real, but isn't wired in as
`TaskAuthorizationManager`'s storage backend yet — that manager's public
API is synchronous in several places used throughout the whole codebase,
and swapping its backend is a real, separate integration decision (see
`docs/PIVOT_AUDIT.md`). The compiled production build
(`node dist/bin/http-server.js`, not just `tsx` against source) was
actually run and verified live — a real bug (two missing runtime assets
in `dist/`) was caught and fixed this way. The `Dockerfile` itself has
not been through `docker build` (no reachable Docker daemon in this
environment) — every file it references was confirmed to exist, and the
command it runs was verified directly, but the container wrapper is
unverified. `docker-compose.yml` runs a real Postgres alongside the app,
but the app doesn't read `DATABASE_URL` yet, for the same reason
`PostgresTaskStore` isn't wired in.

**Designed but not yet built:** no auth/gateway layer in front of the
HTTP API, no idempotency-key support anywhere except `PostgresTaskStore`
itself, no crash recovery/expiry-cleanup daemon.

## Run it

```bash
npm install
npm test
npm run build

npx tsx scripts/demo-flagship.ts   # deterministic, no API key, no cost - the flagship

export ANTHROPIC_API_KEY=sk-...
npm run demo                       # real Anthropic calls, real Ramp Fund reads if .env is set
```

Receipts settle to `.scrip/ramp.json` through `MockRampGateway` — or
through the real `RampApiGateway`/`Meter` if `RAMP_CLIENT_ID`/
`RAMP_CLIENT_SECRET` are set in `.env` (see "Real Ramp integration"
below).

## Library API

```ts
const runtime = new ScripRuntime('scrip.yaml', '.scrip/ramp.json');

const task = await runtime.authorizations.authorizeTask({
  budget: 'research',
  taskId: 'review-pr-418',
  task: 'Review PR 418 with two specialist agents',
  allowance: 1.5,
});

const child = runtime.authorizations.delegate(
  task.credential,
  'security-reviewer',
  0.4,
);

await client.run({
  credential: child.credential,
  estimatedInputTokens: 4_000,
  maxTokens: 1_000,
  messages,
});

// A non-inference economic action - a paid API call, a purchase, compute
// time - uses the exact same atomic reserve/commit primitive.
const apiCall = runtime.authorizations.reserveAction(
  child.credential, 'paid_api', 'vendor_comparison_api', 0.05,
);
runtime.authorizations.commitAction(apiCall.reservationId, 0.031);

const receipt = await runtime.authorizations.settleTask(
  task.authorization.authorizationId,
  { status: 'success', evidence: 'PR merged, tests passing' },
);
```

`TaskExecution`/`ExecutionLease`/`EconomicAction`/`FinanceControlPlane`
are exported type aliases toward this domain's newer vocabulary
(`TaskAuthorization`/`InferenceLease`/`ActionReservation`/`RampGateway`
underneath, unchanged) — see `docs/PIVOT_AUDIT.md` for why the rename is
staged as types-then-fields rather than done in one pass.

## Multi-provider inference

`ScripClient` and `ApprovalController` dispatch to a `ModelProvider`
(Anthropic or OpenAI today) resolved from the model name itself
(`getModelPrice(model).provider`) — the enforcement layer never imports
either provider SDK directly. `scripts/demo-flagship.ts` proves this: two
workers under one task lease, one routed to Claude, one to GPT, both
gated by the same reservation math.

## What happens when a request doesn't fit

Each budget in `scrip.yaml` sets `on_limit`:

- **`deny`** — the call fails before any provider I/O (`SpendLimitExceededError`).
- **`degrade`** — `ScripClient` retries once at the budget's `fallback_model`.
  If that still doesn't fit, it fails the same as `deny`.
- **`request-approval`** — a decoupled `ApprovalController` (a separate
  model, shown only a structured evidence snapshot — never the worker's
  own chat history) renders one verdict per task: a numeric success
  probability, approve iff `p > 0.5`. Approval grants exactly the blocked
  request's shortfall and retries once; denial throws
  `ApprovalRequiredError` and is cached, so a stuck task fails fast
  instead of re-asking. This judges *mid-task continuation* — a distinct
  concept from outcome verification below, which judges the *finished*
  result.

Delegation itself is bounded two ways, independent of `on_limit`:
`max_delegation_depth` caps how many levels deep a worker tree can go
(a hard ceiling, regardless of money left), and `min_request_input_tokens`
/`min_request_output_tokens` set a minimum-viable-allowance floor — a
delegated slice smaller than the cheapest allowed model's minimum
meaningful request is rejected, so depth is also naturally curtailed by
economics on top of the fixed ceiling.

## Outcome verification

`OutcomeVerifier` (`src/outcome-verifier.ts`) is a provider-neutral
interface for attaching *deterministic* evidence to a settled receipt —
preferred over asking a model to declare success from its own narrative.
`GithubPrOutcomeVerifier` (`src/verifiers/github-pr-verifier.ts`) checks
real GitHub state: whether a PR merged, and whether named CI checks
completed successfully. `settleTask()`'s optional `evidenceDetail` param
carries this onto the receipt before it's reported, not bolted on after.

## Connecting an agent over MCP

`npm run mcp-server` starts the MCP server; `.mcp.json` at the repo root
means Claude Code auto-discovers it in this project. Codex, Cursor, and
Claude Desktop use their own MCP config files pointing at the same
command (`npx tsx bin/mcp-server.ts`).

**Verified with a real client, not just unit tests:**
`npx tsx scripts/mcp-smoke-test.ts` spawns the server as a real subprocess
and drives it over the actual MCP protocol — lists tools, then calls all
4 exposed tools in sequence. This caught a real bug unit tests couldn't
(a budget label being resolved to a Fund ID twice — invisible to
`MockRampGateway`, fatal against the real gateway).

MCP is an optional adapter for agents that benefit from tool discovery,
not the durable product boundary. **The gated inference call itself is
not an MCP tool** — an MCP agent can get a task credential over MCP, but
spending against it still requires code that constructs a `ScripClient`
wrapping a real provider client in its own process.

## Operating from a terminal

`npm run cli -- <noun> <verb> ...` exposes the same task lifecycle to a
human operator, organized around the pivot's nouns rather than a flat
command list:

- `budget status <budget>`
- `task authorize <budget> <taskId> <allowance> <description>` /
  `task delegate <credential> <agentId> <allowance>` /
  `task show <authorizationId>` / `task tree <authorizationId>` /
  `task settle <authorizationId> [--status ...] [--evidence "..."]` /
  `task revoke <authorizationId>`
- `action reserve <credential> <actionType> <label> <maximumCost>` /
  `action commit <reservationId> <actualCost>` /
  `action cancel <reservationId>`
- `receipt show <authorizationId>` / `receipt export <authorizationId> [outputPath]`

Each invocation is a separate process; state persists to
`.scrip/leases.json` (override with `SCRIP_LEASE_STORE`) so `task
authorize` and a later `task settle` chain correctly.

## Hosted HTTP API

```bash
npm run http-server   # PORT env var, default 8787
```

```bash
curl -X POST localhost:8787/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"budget":"research","taskId":"task-1","task":"Review PR 418","allowance":1}'
# -> { "credential": "scrip_...", "authorization": {...}, "lease": {...} }

curl -X POST localhost:8787/v1/actions/reserve \
  -H 'Authorization: Bearer scrip_...' -H 'Content-Type: application/json' \
  -d '{"actionType":"paid_api","label":"vendor_api","maximumCost":0.1}'
```

Routes: `POST /v1/tasks`, `GET /v1/tasks/:taskId`, `GET
/v1/tasks/:taskId/tree`, `POST /v1/tasks/:taskId/delegate|settle|revoke`,
`GET /v1/tasks/:taskId/receipt`, `POST /v1/actions/reserve`, `POST
/v1/actions/:actionId/commit|cancel`. Credentials travel as `Authorization:
Bearer <credential>`. No business logic lives in the route layer — every
route is a thin wrapper over the same `src/handlers.ts` functions the CLI
and MCP server call. Errors map to real HTTP status codes:
`InvalidCredentialError`→401, `ApprovalRequiredError`→403,
`SpendLimitExceededError`→402, validation issues→400, unknown
task/receipt lookups→404.

**Not included:** any authentication/authorization layer in front of
these routes. A real deployment needs its own gateway/API-key/mTLS layer
— this is the application boundary, not the network perimeter.

## Real Ramp integration

Drop credentials into `.env` (`RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`,
`RAMP_API_BASE_URL`, plus `ramp_fund_id` on any budget in `scrip.yaml`)
and `createRampGateway()` automatically switches from `MockRampGateway`
to real `RampApiGateway` (Fund balance reads) + `Meter` (usage broadcast
to AI Usage Tracking) — no code changes.

Both directions are live-verified against a real sandbox: real OAuth
token exchange (HTTP Basic Auth), real `GET /developer/v1/funds/{id}`,
real `POST /developer/v1/ai-usage/unified` broadcasts. See
`docs/ramp-api-notes.md` for every confirmed field and gotcha (e.g.
omitting the OAuth `scope` parameter silently returns a scopeless token
that then 403s everywhere; `usage.meters` is required despite Ramp's own
docs describing it as optional).

Ramp remains the system of record for company money, spend policy, and
provider-spend visibility. Scrip governs task identity, worker hierarchy,
atomic reservations, attenuated delegation, and outcome-backed
settlement for one execution — it integrates with Ramp through the
`FinanceControlPlane`/`RampGateway` boundary rather than recreating any
of what Ramp already owns.

## Durable, concurrency-safe persistence

`src/infrastructure/postgres/postgres-task-store.ts`'s `PostgresTaskStore`
answers the question every in-memory system eventually has to: what
happens when two processes reserve against the same remaining balance at
the same instant? `reserveAction()` takes a real row lock (`SELECT ...
FOR UPDATE`) on both the lease and the task authorization for the
duration of one transaction — a concurrent caller blocks until it
commits or rolls back, so two callers racing for the same balance can
never both succeed when only one actually fits. Supports idempotency
keys, so a caller can safely retry a network call without double-reserving.

This is proven with a real test, not asserted: `tests/postgres-task-store.test.ts`
opens two separate connection pools (literally simulating two separate
processes) and fires two reservations at the same instant that together
oversubscribe the balance — asserts exactly one wins, every time. Those
tests need a real Postgres reachable at `PGHOST`/`PGPORT`/`PGUSER`/
`PGDATABASE` (defaults match a project-local dev instance); they skip
cleanly, not fail, when nothing is listening, so `npm test` stays fully
offline-runnable.

**Not yet wired in as the engine's backend.** `TaskAuthorizationManager`
(the thing every other surface in this README actually talks to) still
holds state in-memory, with the CLI's own opt-in single-JSON-file
persistence for chaining across separate invocations — genuinely useful,
but not concurrency-safe the way `PostgresTaskStore` is. Swapping the
backend is real, separate integration work: `TaskAuthorizationManager`'s
public API is synchronous in several places, used throughout the whole
codebase, and changing that is a design decision this repo hasn't made
yet. `docker-compose.yml` runs a real Postgres alongside the app today,
but the app doesn't talk to it — that wiring is the next real piece of
work, not a rename.
