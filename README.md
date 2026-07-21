# Scrip

> Ramp gives you the policy and the pipe. Scrip is the gate in between.

Ramp ships two pieces that don't talk to each other: **Funds** define spend
policy, and **AI Usage Tracking** (`ai-usage/unified`) ingests metered usage
after the fact — Ramp's own docs describe that ingestion as *"purely usage
attribution and cost tracking,"* asynchronous, with no mechanism to ask
permission before spending. **Agent Cards** do gate spend in real time, but
answer a different question — *"may this agent make one purchase?"* — a
single-use PAN capped at one merchant and one amount, unsuited to metered,
per-token billing. Ramp's own AI cost monitoring is alert/threshold
dashboard tooling, checked the same way: no hierarchical delegation, no
concurrent reservation. Across three separate Ramp product surfaces,
nothing gates an AI task's spend *before* it happens, mid-execution, across
however many subagents it spawns.

Scrip answers a different question than Agent Cards:

> **"May this task continue executing?"** — not "may this purchase happen?"

## What a lease is

The real primitive isn't the credential — it's the **lease**. An
`InferenceLease` (`src/lease.ts`) holds remaining budget, reserved budget,
delegated budget, expiration, and delegation depth. The `scrip_…` credential
is just its bearer handle: short-lived, stored only as a SHA-256 hash,
proving "I am executing under lease `L1234`," accepted only by the Scrip
provider proxy. It is not a card PAN and not a provider API key — the proxy
keeps the real Anthropic credentials server-side, and a lease settles into
Ramp's AI Usage Tracking on completion rather than a card transaction.

A lease's lifecycle is a transaction, not a purchase:

```text
authorize task
        ↓
reserve inference budget
        ↓
delegate to child agents          ← attenuation: a child can have
        ↓                           less authority than its parent, never more
reserve every provider call       ← atomic: concurrent subagents
        ↓                           can't jointly oversubscribe one lease
commit usage / release unused
        ↓
settle into Ramp
```

Concretely: a task authorized for $2 spawns three concurrent children.
`delegate()`'s reservation math (`available = parent.allowance - parent.spent -
parent.pending - delegated`) means a research child can reserve $1, a coding
child $0.75, and a third child asking for $0.50 is rejected outright — even
if all three requests arrive at the same instant — because the first two's
reservations already landed before the third is evaluated.
`scripts/demo-scenario.ts` reproduces exactly this against the real code,
no API key required: five subagents request an equal share of a tight
allowance, three run, two are denied *before any provider call*, and the
settlement receipt reconciles to the cent.

```text
Ramp Fund (policy)
        ↓
Scrip task authorization   ← the gate none of Ramp's three surfaces have
        ↓
temporary inference lease
        ↓
Codex / Claude / custom agent
        ↓
model requests and child agents
        ↓
real-time enforcement
        ↓
settlement and receipt
        ↓
Ramp AI Usage Tracking (telemetry)
```

## Run it

```bash
npm install
npm test
npm run build

export ANTHROPIC_API_KEY=sk-...
npm run demo                      # real Anthropic calls, uses scrip.yaml
npx tsx scripts/demo-scenario.ts  # deterministic, no API key, no cost
```

Both write settled task receipts to `.scrip/ramp.json` through
`MockRampGateway` — or through the real `RampApiGateway`/`Meter` if
`RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` are set in `.env` (see "Real Ramp
integration" below).

## Runtime API

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

const receipt = await runtime.authorizations.settleTask(
  task.authorization.authorizationId,
  { status: 'success', evidence: 'PR merged, tests passing' },
);
```

## Connecting an agent over MCP

`npm run mcp-server` starts the MCP server; `.mcp.json` at the repo root
means Claude Code auto-discovers it in this project — no setup needed.
Codex, Cursor, and Claude Desktop use their own MCP config files pointing
at the same command (`npx tsx bin/mcp-server.ts`); consult each tool's own
MCP docs for its config file location and format.

**Verified with a real client, not just unit tests:**
`npx tsx scripts/mcp-smoke-test.ts` spawns the server as a real subprocess
and drives it over the actual MCP protocol (`@modelcontextprotocol/sdk`'s
`Client` + `StdioClientTransport`) — lists tools, then calls
`get_ramp_budget_policy` → `authorize_ai_task` → `delegate_task_allowance`
→ `settle_ai_task` in sequence. This caught a real bug unit tests couldn't
(`getBudgetPolicy` was resolving a budget label to a Fund ID before
calling `getReportedSpend()`, which resolves it again itself — invisible
to `MockRampGateway`, which doesn't care what ID it's asked about, but
fatal against the real gateway).

MCP is an optional adapter for agents that benefit from tool discovery.
It is not the durable product boundary; the task authorization engine and
Ramp gateway are.

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
  instead of re-asking. Requires `controller_model` set on the budget in
  `scrip.yaml`.

Delegation itself is bounded two ways, independent of `on_limit`:
`max_delegation_depth` caps how many levels deep a lease tree can go
(a hard ceiling, regardless of money left), and `min_request_input_tokens`
/ `min_request_output_tokens` set a minimum-viable-allowance floor — a
delegated slice smaller than the cheapest allowed model's minimum
meaningful request is rejected, so depth is also naturally curtailed by
economics on top of the fixed ceiling.

## Real Ramp integration

Drop credentials into `.env` (`RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`,
`RAMP_API_BASE_URL`, plus `ramp_fund_id` on any budget in `scrip.yaml`)
and `createRampGateway()` automatically switches from `MockRampGateway` to
real `RampApiGateway` (Fund balance reads) + `Meter` (usage broadcast to
AI Usage Tracking) — no code changes.

- **Reads: live-verified** against a real sandbox — real OAuth token
  exchange (HTTP Basic Auth), real `GET /developer/v1/funds/{id}`, real
  minor-units-to-dollars conversion. See `docs/ramp-api-notes.md` for
  every confirmed field and gotcha (e.g. omitting the OAuth `scope`
  parameter silently returns a scopeless token that then 403s everywhere).
- **Writes: unit-tested, not yet live-verified** — needs `ai_usage:write`
  scope added to the same OAuth app used for reads (same app, two scopes,
  no separate credential needed).

Not yet built: transactional persistence (state is in-memory per Node
process), webhooks, and provider-key brokering beyond what's here.
