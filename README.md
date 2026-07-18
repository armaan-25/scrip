# SpecSpend

> Virtual cards for AI compute.

Ramp defines the budget. SpecSpend turns it into an enforceable allowance for
one AI task and its subagents.

SpecSpend is the runtime layer between Ramp policy and AI providers. A task gets
one temporary bearer credential. That credential can mint smaller child-agent
leases, but neither a child nor the whole task can exceed its allowance.
Provider calls are preauthorized at their maximum token cost before network I/O,
then settled against actual usage.

```text
Ramp team/project budget
        ↓
SpecSpend task authorization
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
usage reported back to Ramp
```

## What the credential is

The `ss_task_…` value is an inference credential, not a card PAN and not a
provider API key. It is short-lived, policy-bound, stored only as a SHA-256 hash,
and accepted only by the SpecSpend provider proxy. The proxy keeps the actual
Anthropic/OpenAI credentials server-side.

Ramp's own virtual-card and fund APIs remain the source of truth for payment
policy. Production server-side card access uses Ramp's Vault API and requires
the relevant scopes plus PCI qualification. SpecSpend does not log or persist
PAN/CVV data. See [Ramp Spend Controls](https://docs.ramp.com/developer-api/v1/spend-controls)
and [Ramp Virtual Cards](https://docs.ramp.com/developer-api/v1/virtual-cards).

## Run it

```bash
npm install
npm test
npm run build

export ANTHROPIC_API_KEY=sk-...
npm run demo
```

The demo uses `specspend.yaml` and writes settled task receipts to
`.specspend/ramp.json` through `MockRampGateway`.

## Runtime API

```ts
const runtime = new SpecSpendRuntime('specspend.yaml', '.specspend/ramp.json');

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
local `MockRampGateway`. Replace that interface with a production Ramp adapter
to read fund/budget policy and send the final receipt or accounting metadata.
Real Ramp OAuth, webhooks, Vault access, and provider-key brokering are not
claimed as complete.
