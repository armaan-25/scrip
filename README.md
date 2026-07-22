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
inference dispatch, the CLI's full task lifecycle over separate
processes, the MCP server over a real protocol round-trip.

**Built and tested, not yet live-verified against a real external
service:** `GithubPrOutcomeVerifier` (real GitHub REST API shapes,
confirmed against GitHub's own docs, but only unit-tested against a fake
`fetch` — no `GITHUB_TOKEN` configured in this environment yet).

**Designed but not yet built:** durable transactional persistence beyond
the CLI's opt-in local JSON file (no Postgres store, no idempotency keys,
no crash recovery), a hosted HTTP API, a task/action-oriented CLI command
reshape (the CLI today is still `scrip status|authorize|delegate|settle|revoke`,
not the `scrip task ...`/`scrip action ...` shape a broader execution
platform implies — see `docs/PIVOT_AUDIT.md`).

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

`npm run cli -- <command>` exposes the same task lifecycle to a human
operator: `status <budget>`, `authorize <budget> <taskId> <allowance>
<description>`, `delegate <credential> <agentId> <allowance>`, `settle
<authorizationId> [--status ...] [--evidence "..."]`, `revoke
<authorizationId>`. Each invocation is a separate process; state
persists to `.scrip/leases.json` (override with `SCRIP_LEASE_STORE`) so
`authorize` and a later `settle` chain correctly.

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
