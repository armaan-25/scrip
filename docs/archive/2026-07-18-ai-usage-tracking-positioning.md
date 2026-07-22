# AI Usage Tracking Positioning + Real Usage Write Design

> Archived design. This document describes an obsolete product direction
> and is not the current architecture - it's positioning research from
> before the execution-economics pivot. The write path it designed
> (Meter/`ai-usage/unified`) has since been built and live-verified - see
> docs/ramp-api-notes.md and ARCHITECTURE.md.

## Goal

Reposition SpecSpend away from "virtual cards for AI compute" — a framing
that invites direct, losing comparison to Ramp's own Agent Cards product —
toward its more precise and more defensible claim: SpecSpend is the
pre-call enforcement layer that sits between two things Ramp already ships
but doesn't connect — Fund policy and AI Usage Tracking telemetry. Make
`reportTaskUsage()` a real Ramp write via Ramp's actual, self-serve
`POST /developer/v1/ai-usage/unified` broadcast-destination API, instead of
staying local-only pending Vault approval.

## Why the reposition

Three real Ramp primitives were checked against this product's claims by
reading Ramp's own developer docs directly (`docs.ramp.com`):

| Ramp primitive | What it does | Why it isn't this product |
|---|---|---|
| Agent Cards | Real-time pre-purchase authorization | Single-use, one-merchant, 12hr TTL; explicitly excludes card-on-file / metered billing — the exact pattern an Anthropic API key uses |
| Funds / Spend Programs | Define recurring budget policy | Policy definition, not per-call enforcement |
| AI Usage Tracking (`ai-usage/unified`) | Ingest metered usage after the fact | Explicitly visibility-only: `"purely usage attribution and cost tracking"`, async (`204 No Content`, ingested asynchronously), no mechanism to ask permission before spending |

Nothing in Ramp's stack gates spend before a metered AI call happens.
`TaskAuthorizationManager` already does exactly that (`reserveRequest`
before provider I/O, `commitRequest` after, hierarchical `delegate()` for
subagents with atomic oversubscription prevention). The honest, checkable
claim is: **Ramp gives you the policy and the pipe; SpecSpend is the gate
in between, and it settles real, already-authorized usage back through
that same pipe.**

## Positioning changes (amend in place, no new positioning doc)

### `README.md`

- Replace the `> Virtual cards for AI compute.` tagline and the
  `Ramp defines the budget. SpecSpend turns it into an enforceable
  allowance...` line with framing centered on the enforcement gap: Ramp
  ships policy (Funds) and telemetry (AI Usage Tracking) as two separate,
  unconnected primitives; SpecSpend is the missing pre-call gate between
  them.
- Update the flow diagram to name the two Ramp primitives explicitly
  instead of a generic "Ramp team/project budget" / "usage reported back
  to Ramp" pair:

  ```text
  Ramp Fund (policy)
          ↓
  SpecSpend task authorization  ← the gate Ramp doesn't have
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

- Add a short paragraph quoting Ramp's own docs on why `ai-usage/unified`
  alone isn't sufficient (async, visibility-only, no pre-call gate) —
  the claim should be checkable against Ramp's own published documentation,
  not asserted on SpecSpend's authority alone.
- Remove the "What the credential is" section's card-PAN comparison
  framing in favor of describing the credential as scoped to one task's
  enforcement lifecycle, settling into AI Usage Tracking on completion.

### `ARCHITECTURE.md`

- Rewrite the "Ramp policy and reporting" section: `RampGateway` reads
  Fund policy on one side and writes to AI Usage Tracking on the other;
  `MockRampGateway`/`RampApiGateway` are adapters over that same seam, not
  a card-issuance analogy.
- Add the enforcement-gap table above (or a condensed version of it) as
  the architectural justification for why this product exists as
  middleware rather than being redundant with Ramp's own AI Agents
  surface.

## New component: `Meter`

### `src/meter.ts`

```ts
export interface MeterConfig {
  apiKey: string;   // customer's Ramp API key (Settings > Integrations), from RAMP_AI_USAGE_API_KEY
  baseUrl: string;  // shared with RampApiGateway's baseUrl
  source: string;   // platform name sent as `source`, e.g. "specspend"
}

export class Meter {
  constructor(config: MeterConfig, fetchFn?: HttpFetch)
  async reportUsage(receipt: TaskReceipt): Promise<void>
}
```

- `reportUsage()` maps one `TaskReceipt` to one `ai-usage/unified` batch
  request: one `events[]` entry per `ModelUsage` (a task can span multiple
  models across its subagents).
- Per event: `event_id` derived from `` `${receiptId}:${model}` `` for
  dedup-safe idempotency; `provider` set from the model's known provider
  (`"anthropic"` for every model this project currently routes to);
  `model` from the `ModelUsage` entry; `usage.input_tokens`/
  `output_tokens` from the aggregated event; `occurred_at` from
  `receipt.settledAt`.
- `attribution.session_id`: `receipt.authorizationId`. `attribution.tags`:
  a string map of `{ team: receipt.team, budgetName: <resolved from
  authorization>, taskId: receipt.taskId, costCenter: receipt.costCenter,
  childAgents: String(receipt.childAgents) }`.
- `reported_cost.amount`: that model's aggregated cost, as a decimal
  string. `reported_cost.estimated: false` — this is a post-hoc, exact,
  commit-time cost, not a guess.
- `pricing_context` fields (`service_tier`, `fast_mode`,
  `session_created_at`, `long_context`) get honest defaults
  (`"standard"`, `false`, `receipt.startedAt`, `false`) since SpecSpend
  doesn't track those dimensions today — documented as defaults, not
  fabricated signal.
- Auth header format (`Authorization: Bearer <apiKey>` vs. some other
  scheme) is a **known unknown, same treatment as the read side**:
  verified against `docs/ramp-api-notes.md` before this is implemented,
  not guessed and shipped as if confirmed.
- No retry logic: a single attempt, throws on non-2xx. This is a
  deliberate MVP scope cut (Ramp's own docs recommend exponential-backoff
  retry, which is real production guidance being knowingly deferred, not
  overlooked).

## `RampApiGateway.reportTaskUsage()` changes

Composes two writes with different failure semantics:

1. `LocalReceiptStore.addReceipt()` — always runs, unconditionally. This
   remains the source of truth for the demo harness and for anything that
   reads receipts back within this process.
2. `Meter.reportUsage()` — best-effort. Failures are caught, logged
   (`console.warn` with the receipt ID and error), and swallowed — they do
   not propagate to the caller of `reportTaskUsage()`.

This is a deliberate asymmetry from the read side's policy
(`getReportedSpend()` throws loudly on failure, because a wrong "remaining
budget" number gates a real spending decision). A failed broadcast to AI
Usage Tracking happens *after* the money is already committed — it's a
reporting gap, not a control failure, so it's a warning, not a blocker.

## Config additions

`.env.example` gains `RAMP_AI_USAGE_API_KEY` alongside the existing
`RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET`/`RAMP_API_BASE_URL` — separate from
the OAuth client-credentials pair because Ramp's own model for this
specific endpoint is a static, customer-generated API key, not an OAuth
app token. `createRampGateway()` in `src/runtime.ts` only constructs a
`Meter` (passed into `RampApiGateway`) when `RAMP_AI_USAGE_API_KEY` is
set; if unset, `RampApiGateway` still does real Fund reads but
`reportTaskUsage()` falls back to local-only writes with a logged notice
— reads and writes can be independently "real" depending on which
credentials are present.

## Testing

- `tests/meter.test.ts` — request shape assertions (one event per
  `ModelUsage`, correct `attribution.tags`, idempotent `event_id`) against
  an injected fake HTTP client; error propagation on non-2xx (verifying
  `Meter.reportUsage()` itself throws, since the swallow-and-log behavior
  belongs to `RampApiGateway`, not `Meter`).
- `tests/ramp-api-gateway.test.ts` gains a case proving a `Meter` failure
  doesn't prevent the local receipt from being written, and doesn't throw
  out of `reportTaskUsage()`.
- No test hits the real Ramp API.

## Amendment to the prior RampGateway design doc

`docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`'s framing of
`reportTaskUsage()` as permanently mocked "pending Vault approval" is
superseded by this design — the write path is real via `ai-usage/unified`,
which needs no special Ramp partnership approval (self-serve, customer
brings their own API key). That doc's read-side scope (Funds balance via
OAuth client-credentials) is unaffected and still applies, though its
"Limits" resource naming and body-based OAuth grant were already flagged
as corrections to make in a prior conversation, tracked separately from
this design.

## Out of scope

- Retry/backoff for the broadcast write (deferred, noted above).
- Reconciling local receipts against what Ramp actually ingested (no
  read-back API for previously broadcast usage events is in scope here).
- The Funds-side read corrections (OAuth Basic Auth, "Limits" → "Funds"
  renaming) — tracked as a follow-up to the existing gateway plan, not
  this design.
