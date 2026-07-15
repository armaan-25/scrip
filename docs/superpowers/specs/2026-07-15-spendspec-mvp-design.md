# SpendSpec MVP Design

## Goal

Give every AI call a team/project/feature identity, a budget policy visible to
the agent before it runs, and runtime enforcement that a model can't talk its
way around. MVP target: a live demo where a Claude Code-driven task sees its
real remaining budget, adjusts its plan, and gets hard-capped by a proxy
enforcing real dollar limits on real Anthropic API calls.

## Stack

TypeScript / Node. Single process for the MVP — no separate services, no
Python runtime. Claude Code is the demo's MCP client.

## Components

### 1. Config layer (`src/config.ts` + `spendspec.yaml`)

Loads the team → project → feature hierarchy from YAML:

```yaml
team: search-platform
projects:
  recommendations:
    monthly_budget: 8000
    warning_threshold: 0.8
    features:
      query-rewrite:
        monthly_budget: 1500
        max_per_request: 0.02
        allowed_models: [claude-haiku-4-5, claude-sonnet-5]
        fallback_model: claude-haiku-4-5
        on_limit: degrade
```

Parsed into a typed `SpendConfig` tree. No hot-reload for MVP — process
restart picks up changes.

### 2. Mock Ramp store (`src/store.ts`)

A local JSON file (`.spendspec/store.json`) tracking, per project/feature:
spend-to-date this month, and an append-only log of receipts. A receipt has
the shape described in the spec doc (team, project, feature, task, authorized,
actual, model, cost center) — logged to console and appended to the file.
Nothing calls a real Ramp endpoint.

### 3. MCP server (`src/mcp-server.ts`)

Exposes exactly four tools, backed by the config layer + store:

- `get_spend_policy(team, project, feature?, task?)` → project budget
  remaining + task-level policy (soft/hard limit, allowed models, fallback,
  approval threshold).
- `estimate_spend(project, feature, plan_description)` → rough dollar
  estimate for a described plan, using the price table (ballpark: token
  count heuristics × model price, not a real LLM-based estimator for MVP).
- `request_more_budget(project, feature, amount, reason)` → mocked
  approve/deny; MVP auto-approves under a configurable ceiling and logs a
  pending-approval record above it.
- `record_usage(lease_id, actual_cost, model, task)` → writes a receipt to
  the mock store and releases the lease.

### 4. Price table + BudgetRouter (`src/pricing.ts`, `src/router.ts`)

`src/pricing/model_price.json` is ported directly from agentopt's price table
(same `{model: {input_price, output_price}}` shape) so cost math doesn't need
a hand-maintained list.

`BudgetRouter.route(ctx)` takes `{ remainingBudget, taskEstimate,
allowedModels }` and returns a model name — modeled on agentopt's
`Router.route(ctx) -> model` interface, but the policy is budget-driven
rather than accuracy-driven: pick the richest allowed model that fits
comfortably under remaining budget, degrade to `fallback_model` when tight.

### 5. LLM proxy + budget lease (`src/proxy.ts`, `src/lease.ts`)

`ai.run()` (the developer-facing entry point from the spec) does:

1. Ask the MCP server / lease manager for a lease: `{ lease_id,
   reserved_amount, expires_at }`, sized from `estimate_spend` and capped by
   `max_per_request`.
2. Call the real Anthropic SDK (`@anthropic-ai/sdk`) with the model chosen
   by `BudgetRouter`.
3. Compute actual cost from the response's real `usage.input_tokens` /
   `usage.output_tokens` against the price table.
4. If actual cost would exceed the lease, apply `on_limit` policy
   (`degrade`: retry once with `fallback_model`; `request-approval`: call
   `request_more_budget`; otherwise throw).
5. Call `record_usage` with the real cost, release unused lease amount back
   to the project.

This is the one component making real, billed API calls — everything else
is bookkeeping around it.

### 6. Demo harness (`demo/run-demo.ts`)

A CLI script playing the "agent" role end-to-end for the Best Builder Cup
scenario: calls `get_spend_policy` for a "Research Agent" project with a
small remaining budget, calls `estimate_spend` for a 5-parallel-agent plan,
sees it doesn't fit, revises to 2 agents on a cheaper model (mirroring the
spec's own demo transcript), runs the real Anthropic calls through the
proxy, and prints the before/after cost comparison plus the final receipt.

## Build order

1. Config layer + `spendspec.yaml` with the two demo projects (`Support
   Agent` $10, `Research Agent` $2).
2. MCP server exposing the 4 tools against the config + mock store.
3. Price table port + `BudgetRouter`.
4. LLM proxy wrapping real Anthropic calls, with lease enforcement.
5. Mock Ramp receipts wired into `record_usage`.
6. Demo harness script reproducing the spec's demo transcript.

Each step is independently runnable/testable before moving to the next.

## Out of scope for MVP

- Real Ramp API integration.
- Any dashboard/UI.
- Approval-flow UI — "approval needed" is a logged state, not a workflow.
- agentopt's BERT router (accuracy-optimized, needs GPU/HF checkpoint —
  wrong objective for budget-driven routing anyway).
- Real multi-agent orchestration — "5 parallel agents" is simulated as
  concurrent `ai.run()` calls, not a framework.
- Config hot-reload, multi-team support beyond the YAML example, currency
  handling beyond USD.

## Testing

Unit tests for `BudgetRouter` model selection, price-table cost math, and
lease lifecycle (reserve → spend → release) using mocked Anthropic
responses. The demo harness itself is exercised manually (real API calls
cost real money) rather than in CI.
