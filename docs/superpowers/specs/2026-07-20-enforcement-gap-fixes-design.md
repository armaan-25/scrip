# Enforcement Gap Fixes: onLimit Wiring + Hierarchical Depth Bounding

## Goal

Fix two gaps found by inspecting the current code, both the same underlying
theme: enforcement is stricter than configured in one place, and looser than
safe in another.

1. `RampBudgetConfig.onLimit` is declared and set in `scrip.yaml` but never
   read by `ScripClient.run()` — every budget behaves like `deny` today
   regardless of configuration.
2. `TaskAuthorizationManager.delegate()` has no bound on how deep a
   delegation chain can go, and no floor on how small a delegated slice can
   be — an agent can recursively fragment budget into an unbounded number
   of near-zero leases.

This directly answers the "hierarchical subagent budgets" problem
(ramp.com/ai-cost-monitoring's own framing: a parent with $10 launching
concurrent children that must reserve atomically, with a third child
correctly rejected if the first two already consumed enough). That atomic
reservation already exists (`delegate()`'s `available = parent.allowance -
parent.spent - parent.pending - delegated` math, unchanged by this design)
— what's missing is depth/floor bounding on top of it, and the config knob
that decides what happens when a request doesn't fit.

**Verified against Ramp's own product surface:** ramp.com/ai-cost-monitoring
was checked directly. It's alert/threshold/dashboard tooling — "set limits
by key and notify the owner... when spending hits that threshold" — no
mention of hierarchical delegation, concurrent reservation, or an execution
tree that reserves and returns budget mid-run. This is the same gap
identified earlier against Funds/AI Usage Tracking/Agent Cards, now
confirmed against a third Ramp product surface: nothing in Ramp's stack
does what `TaskAuthorizationManager` already does.

## Gap 1: wire `onLimit` into `ScripClient.run()`

`reserveRequest()`'s call moves inside a `try/catch`:

- `onLimit === 'degrade'` and the routed `model !== budget.fallbackModel` →
  recompute cost at `budget.fallbackModel`, retry `reserveRequest()` once.
  If that also throws, the error propagates — one retry only, no loop.
- `onLimit === 'request-approval'` → rethrow as a new `ApprovalRequiredError`
  (distinct from `SpendLimitExceededError`) so callers can tell the
  difference. No approval-callback mechanism is built here — that's the
  evidence-based controller idea from earlier, out of scope for this fix.
- `onLimit === 'deny'` (or unrecognized) → rethrow unchanged, today's
  behavior.

## Gap 2: depth ceiling + minimum-viable-allowance floor

`RampBudgetConfig` gains three configurable fields (`RawBudget`/`scrip.yaml`
snake_case: `max_delegation_depth`, `min_request_input_tokens`,
`min_request_output_tokens`):

```ts
maxDelegationDepth: number;
minRequestInputTokens: number;
minRequestOutputTokens: number;
```

`scrip.yaml`'s `research`/`support` budgets get `3` / `500` / `200` as
starting values — configurable per budget, not hardcoded, per explicit
instruction. 3 covers realistic fan-out (root → child → grandchild)
without being restrictive; 500/200 tokens matches the sizes already used
throughout the test suite and demo script, grounding the floor in real
request sizes already in the codebase rather than an arbitrary number.

`InferenceLease` gains `depth: number` — `0` for the root lease minted in
`authorizeTask()`, `parent.depth + 1` for every child minted in
`delegate()`.

`delegate()` gains two checks before its existing "fits inside parent's
remaining allowance" check:

1. `parent.depth >= budget.maxDelegationDepth` → throw
   `SpendLimitExceededError`. Hard ceiling, independent of how much money
   is left — stops a runaway recursive-spawn bug even on a large budget
   where money alone wouldn't stop it.
2. `allowance < computeCost(cheapestAllowedModel, budget.minRequestInputTokens, budget.minRequestOutputTokens)`
   → throw `SpendLimitExceededError`. A small unexported `cheapestModel()`
   helper in `lease.ts` picks the lowest-`outputPrice` model from
   `allowedModels` — the mirror image of what `BudgetRouter` already does
   for the priciest. Depth is naturally curtailed by economics on top of
   the fixed ceiling: a task with more budget can go deeper before hitting
   this than one with very little, which is the budget-adaptive half of
   depth bounding.

Neither check touches the existing atomic-reservation math — a child still
can never receive more than its parent has genuinely got left. These are
additive safety bounds on top of correctness that already holds.

## New error type

`src/lease.ts` gains `export class ApprovalRequiredError extends Error {}`,
alongside the existing `SpendLimitExceededError`/`InvalidCredentialError`.

## Testing

`tests/lease.test.ts`: depth ceiling rejects at the configured limit and
accepts one level under it; minimum-allowance floor rejects a too-small
delegation and accepts one at/above the floor.

`tests/proxy.test.ts`: `degrade` retries once and succeeds on the fallback
model; `degrade` still throws if the fallback model also doesn't fit;
`request-approval` throws `ApprovalRequiredError`; `deny` throws
`SpendLimitExceededError` unchanged (regression coverage for existing
behavior).

## Out of scope

- An actual approval-callback/controller mechanism for `request-approval`
  (evidence-based controller design, discussed earlier, is its own future
  feature).
- `maxTokens`/reasoning-budget shrinking as part of `degrade` — scoped to
  fallback-model-only retry per explicit decision; token/reasoning-budget
  shrinking remains a separate future design if wanted.
- Real Ramp integration (`RampApiGateway`/`Meter`) — separate workstream,
  next after this and the docs unification pass.
