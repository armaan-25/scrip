# Scrip

> Ramp gives you the policy and the pipe. Scrip is the gate in between.

Ramp ships two pieces that don't talk to each other: **Funds** define spend
policy, and **AI Usage Tracking** (`ai-usage/unified`) ingests metered usage
after the fact — Ramp's own docs describe that ingestion as *"purely usage
attribution and cost tracking,"* asynchronous, with no mechanism to ask
permission before spending. Nothing in Ramp's stack gates an AI task's spend
*before* it happens. Scrip is that gate: it authorizes a scoped, temporary
credential per task against a real Ramp Fund, reserves and commits every
provider call's cost before the request goes out — so a task's own subagents
can't oversubscribe it even running concurrently — then settles real,
already-authorized usage back through AI Usage Tracking.

```text
Ramp Fund (policy)
        ↓
Scrip task authorization   ← the gate Ramp doesn't have
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

## What the credential is

The `scrip_…` value is an inference credential, scoped to one task's
enforcement lifecycle — not a card PAN, not a provider API key, and not
modeled after Ramp's Agent Cards (which mint single-use, single-merchant
instruments unsuited to metered, per-token billing). It is short-lived,
policy-bound, stored only as a SHA-256 hash, and accepted only by the Scrip
provider proxy. The proxy keeps the actual Anthropic/OpenAI credentials
server-side, and the credential settles into Ramp's AI Usage Tracking on
task completion rather than a card transaction.

## Run it

```bash
npm install
npm test
npm run build

export ANTHROPIC_API_KEY=sk-...
npm run demo
```

The demo uses `scrip.yaml` and writes settled task receipts to
`.scrip/ramp.json` through `MockRampGateway`.

## Runtime API

```ts
const runtime = new ScripRuntime('scrip.yaml', '.scrip/ramp.json');

const task = runtime.authorizations.authorizeTask({
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

const receipt = runtime.authorizations.settleTask(
  task.authorization.authorizationId,
);
```

MCP is an optional adapter (`npm run mcp-server`) for agents that benefit from
tool discovery. It is not the durable product boundary; the task authorization
engine and Ramp gateway are.

## Current integration boundary

The prototype implements the full credential and settlement lifecycle with a
local `MockRampGateway`. Replace that interface with a production adapter
that reads real Fund balances (OAuth client-credentials against Ramp's Funds
API) and broadcasts settled receipts to `ai-usage/unified` (AI Usage
Tracking) — designed in
[`docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`](docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md)
and
[`docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md`](docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md),
not yet implemented. Real Ramp OAuth, webhooks, and provider-key brokering
are not claimed as complete.
