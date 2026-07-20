# Scrip Architecture

## Runtime boundaries

### Why this exists between three things Ramp already ships

Checked directly against Ramp's own docs, three times, three different
product surfaces:

- **Funds API** — defines spend policy. Doesn't gate a call before it's made.
- **AI Usage Tracking** (`ai-usage/unified`) — ingests metered usage after
  it happens. Ramp's own docs describe it as visibility-only, asynchronous
  ingestion, no permission mechanism.
- **Agent Cards** — does gate spend in real time, but per-purchase: a
  single-use PAN capped at one merchant and one amount, explicitly
  unsuited to card-on-file/metered billing (the pattern an Anthropic API
  key actually uses).
- **AI cost monitoring** (ramp.com/ai-cost-monitoring) — alert/threshold
  dashboard tooling: "set limits by key and notify... when spending hits
  that threshold." No hierarchical delegation, no concurrent reservation.

`TaskAuthorizationManager` is the piece that sits between policy and
telemetry: it reads Fund policy, authorizes and enforces spend *before* any
provider call — including atomically across however many concurrent
subagents one task spawns — then settles into the telemetry pipe.

### Ramp policy and reporting

`src/store.ts` defines `RampGateway`: `getReportedSpend()` reads policy,
`reportTaskUsage()` reports settled usage. `MockRampGateway` is the local
adapter: it reads settled usage and persists final task receipts. A
production adapter (`RampApiGateway`, reading real Funds via OAuth
client-credentials and broadcasting to `ai-usage/unified` via `Meter`) can
replace it without changing enforcement — designed but not yet implemented,
see
[`docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`](docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md)
and
[`docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md`](docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md).

### Authorization domain

`src/lease.ts` owns `TaskAuthorizationManager` — the actual product. Task
authorizations, hierarchical inference leases (each tracking `depth`),
bearer credential hashing, in-flight request reservations, revocation, and
settlement aggregation. This state currently lives in the Node process
(see Production gaps below).

Two bounds live here, both configurable per Ramp budget in `scrip.yaml`
(see
[`docs/superpowers/specs/2026-07-20-enforcement-gap-fixes-design.md`](docs/superpowers/specs/2026-07-20-enforcement-gap-fixes-design.md)):

- `maxDelegationDepth` — a hard ceiling on how many levels deep `delegate()`
  can go, independent of remaining budget. Money alone can't stop a
  runaway recursive-spawn bug; this does.
- `minRequestInputTokens`/`minRequestOutputTokens` — computed against the
  budget's cheapest allowed model into a minimum-viable-allowance floor.
  `delegate()` rejects a slice too small to afford even one meaningful
  call, so depth is also curtailed by economics: a larger task budget can
  delegate deeper than a tiny one before hitting this.

Neither bound touches the atomic reservation math
(`available = parent.allowance - parent.spent - parent.pending -
delegated`) — a child still can never receive more than its parent has
genuinely got left, with or without these checks.

### Provider enforcement

`src/proxy.ts` owns `ScripClient`. It selects an allowed model, derives a
conservative input-token ceiling from the message bytes, reserves the
maximum possible request cost, calls Anthropic, and commits real token
usage. Provider keys live in this process and never flow to agents.

`ScripClient.run()` reads the budget's `onLimit` policy when a reservation
doesn't fit:

- `'degrade'` — one retry at `fallbackModel`. If that also doesn't fit, the
  error propagates unchanged.
- `'request-approval'` — throws `ApprovalRequiredError` (distinct from
  `SpendLimitExceededError`) so a caller can build an approval flow later.
  No approval-callback mechanism exists yet.
- `'deny'` (or anything else) — throws `SpendLimitExceededError` unchanged.

### Interfaces

`src/handlers.ts` exposes transport-independent task operations.
`src/mcp-server.ts` wraps those operations for MCP-capable agents. MCP is an
adapter, not the state or enforcement layer.

## End-to-end flow

```text
Caller selects budget + task allowance
→ TaskAuthorizationManager validates Ramp policy and reserves allowance
→ root agent receives a temporary credential (lease depth 0)
→ root delegates smaller credentials to child agents (depth + 1 each,
  bounded by maxDelegationDepth and the minimum-viable-allowance floor)
→ ScripClient computes the provider request ceiling
→ TaskAuthorizationManager reserves it against lease + task
  (on failure: degrade retries once, request-approval raises
  ApprovalRequiredError, deny throws)
→ Anthropic request executes
→ actual tokens replace the pending reservation
→ settleTask closes every lease and aggregates one receipt
→ RampGateway reports task usage to Ramp's AI Usage Tracking
```

## Failure propagation

- Invalid, expired, settled, or revoked credentials fail before provider I/O.
- Disallowed models and unaffordable request ceilings fail before provider
  I/O, subject to the `onLimit` policy above.
- Delegation past `maxDelegationDepth` or below the minimum-viable-allowance
  floor fails before a child credential is ever minted.
- Provider errors release pending reservations and propagate to the caller.
- Settlement rejects while a request is in flight.
- A provider response above its preauthorized ceiling is rejected and not
  charged to the task receipt.

## Production gaps

The next durable boundary is transactional persistence for authorizations
and reservations, with idempotency keys and expiry cleanup — today's state
is in-memory per Node process. Real Ramp OAuth, the `RampApiGateway`/`Meter`
production adapter, webhooks, and provider-key brokering are designed (see
specs above) but not yet implemented. `request-approval`'s
`ApprovalRequiredError` has no callback/controller behind it yet — an
evidence-based approval mechanism (a decoupled judge seeing task state, not
the worker's self-report) is a deliberate future design, not this one.
