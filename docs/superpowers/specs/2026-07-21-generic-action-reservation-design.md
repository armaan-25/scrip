# Generic Action Reservation Design

## Goal

Prove the "economic control plane for a task" reframe narrowly, without
committing to the full Phase 1 infrastructure investment (Postgres, hosted
gateway, multi-provider adapters) that reframe's own proposal correctly
says shouldn't happen all at once. Generalize the existing atomic
reserve/commit/cancel pattern from inference-only to any resource type,
staying in-memory, Anthropic-only, and local — same guarantees, wider
applicability.

## What generalizes and what doesn't

`TaskAuthorizationManager.reserveRequest()`/`commitRequest()`/
`cancelRequest()` are inference-specific: they take a `model` and validate
it against `allowedModels`, and `commitRequest()` takes `inputTokens`/
`outputTokens`. The atomicity and bookkeeping underneath (pending vs.
spent, lease-and-task dual-checking) has nothing to do with tokens — it
already works purely in dollars.

**New generic primitive:**

```ts
export type ActionType = 'inference' | 'paid_api' | 'purchase' | 'other';

reserveAction(credential: string, actionType: ActionType, label: string, maximumCost: number): RequestReservation
commitAction(reservationId: string, actualCost: number): void
cancelAction(reservationId: string): void
```

`label` is a free-form identifier — a model name for inference, a vendor
name for a paid API call ("exa_search"), a merchant name for a purchase.
No model-allowlist validation happens here; that's specific to inference.

**Existing methods become thin wrappers, zero behavior change:**

```ts
reserveRequest(credential, model, maximumCost) {
  // model-allowlist check stays here, unchanged
  return this.reserveAction(credential, 'inference', model, maximumCost);
}

commitRequest(reservationId, inputTokens, outputTokens, actualCost) {
  this.commitAction(reservationId, actualCost);
  // token counts still recorded for modelUsage aggregation
}
```

Every existing test keeps passing unmodified — this is a refactor
underneath a stable public API, not a breaking change.

## Receipt breakdown by action type

`TaskReceipt` gains `actionUsage: { actionType: ActionType; count: number; cost: number }[]`
alongside the existing `modelUsage` — the concrete, demonstrable version
of the reframe's "inference $2.86 / tools $0.20 / purchases $480" example.
`modelUsage` is unchanged (inference-specific, token-level detail);
`actionUsage` is the new type-level rollup across everything, inference
included.

## Proof of concept: one non-inference action type, end to end

A new demo scenario (`scripts/demo-generic-action.ts`) authorizes a task,
reserves and commits a `paid_api` action (e.g. a $0.02 search API call)
alongside a real `inference` action through `ScripClient`, settles the
task, and prints a receipt showing both action types broken down — proving
the same lease that gates a Claude call can gate an unrelated paid API
call, with the same atomicity guarantees, no new infrastructure.

## Explicitly out of scope for this pass

- Renaming `InferenceLease` → `ExecutionLease` (cosmetic, no functional
  need to do it now, and it would touch every file for no proof-of-concept
  benefit).
- PostgreSQL / any persistence change — state stays in-memory, exactly as
  documented as a known limitation already.
- Hosted HTTP gateway, OpenAI/other provider adapters, Agent Card
  purchase flow, MPP/x402 — each is its own real scope, not proven or
  disproven by this change.
- Any of the cross-product competitive claims (Bedrock, LiteLLM, A2A,
  Stripe MPP) — unverified against primary sources, not relied on by this
  design.

## Testing

- All existing `reserveRequest`/`commitRequest`/`cancelRequest` tests
  pass unchanged (refactor correctness).
- New tests: `reserveAction`/`commitAction`/`cancelAction` work
  independent of any model concept; a `paid_api` reservation can't exceed
  lease/task remaining, same as inference; `actionUsage` breakdown on
  `TaskReceipt` correctly aggregates mixed action types.
