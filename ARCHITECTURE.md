# Scrip Architecture

> **Mid-pivot.** This repo is moving from an inference-budget prototype
> toward a broader execution-economics platform for autonomous work. The
> domain mechanism described below (atomic reserve/commit/cancel over any
> action type, not just inference) was already generalized before the
> pivot began, and the CLI has since been reshaped around task/action/
> receipt nouns — see `docs/PIVOT_AUDIT.md` for the full classification of
> what's built, what's a rename-in-progress, and what's genuinely new
> (durable Postgres persistence and a hosted HTTP API don't exist yet).

## What this is

Scrip authorizes, meters, and settles autonomous work. The core unit is a
task, not an inference request: one job that may spawn concurrent
workers, call multiple model providers, hit paid APIs, and needs its full
economics settled against a verified outcome. It sits between an agent
(or a fleet of delegated subagents) and whatever it spends money on —
authorizing and reserving spend *before* execution, then settling and
reporting real usage to Ramp afterward. It is not a dashboard, not an
after-the-fact usage tracker, and not a per-purchase card product — see
"Why this exists between three things Ramp already ships" below for how
it differs from what Ramp itself ships today.

Stack: TypeScript/Node, ESM (`"type": "module"`), Vitest, `js-yaml` for
config, real `@anthropic-ai/sdk` and `openai` SDKs, `@modelcontextprotocol/sdk`
for the MCP surface.

## Runtime boundaries

### Why this exists between three things Ramp already ships

Checked directly against Ramp's own docs and Ramp's own internal
assistant, more than once, across different product surfaces:

- **Funds API** — defines spend policy (a monthly limit per Fund). Doesn't
  gate an individual call before it's made.
- **AI Usage Tracking** (`ai-usage/unified`) — ingests metered usage
  *after* it happens. Visibility-only, asynchronous ingestion, no
  permission mechanism.
- **Agent Cards** — does gate spend in real time, but per-purchase: a
  single-use PAN capped at one merchant and one amount, explicitly
  unsuited to card-on-file/metered billing (the pattern a real Anthropic
  or OpenAI API key actually uses).
- **AI cost monitoring** (ramp.com/ai-cost-monitoring) — alert/threshold
  dashboard tooling: "set limits by key and notify... when spending hits
  that threshold." No hierarchical delegation, no concurrent atomic
  reservation.

`TaskAuthorizationManager` is the piece that sits between policy and
telemetry: it reads real Fund policy, authorizes and enforces spend
*before* any provider call — including atomically across however many
concurrent subagents one task spawns — then settles into the real
telemetry pipe.

### Authorization domain (the actual product)

`src/lease.ts` owns `TaskAuthorizationManager`. Core state:

- **`TaskAuthorization`** — one per top-level task: a Ramp-budget-backed
  allowance, `spent`/`pending` tracking, status (`active`/`settled`/`revoked`),
  TTL.
- **`InferenceLease`** — a credential-bearing lease, one per agent in the
  delegation tree (the root task itself is `depth: 0`, `agentId: 'root'`).
  Each child lease tracks its own `depth`, `parentLeaseId`, and its own
  `allowance`/`spent`/`pending`, independent of its parent's.
- **`ActionReservation`** (aliased `EconomicAction`) — an atomic
  reserve/commit/cancel unit with a real status lifecycle
  (`'reserved'|'committed'|'cancelled'`, actually transitioned by
  `commitAction`/`cancelAction`, not just declared). The generic
  primitive: `reserveAction(credential, actionType, label, maximumCost,
  metadata?)` → `commitAction(reservationId, actualCost, tokenUsage?)`
  or `cancelAction(reservationId)`. `actionType` is `'inference' |
  'paid_api' | 'purchase' | 'cloud_compute' | 'human_approval' | 'other'`
  (the last two declared for forward compatibility, not yet exercised by
  any real caller) — the same atomicity guarantees that gate a real
  Anthropic/OpenAI call also gate an unrelated paid API call or purchase,
  with no new infrastructure. `reserveRequest`/`commitRequest`/
  `cancelRequest` are thin inference-specific wrappers over this (they add
  the `allowedModels` check) — kept for existing callers, zero behavior
  change. `scripts/demo-flagship.ts` exercises `paid_api` directly.
- **Domain vocabulary aliases** — `TaskExecution`/`ExecutionLease`/
  `EconomicAction`/`FinanceControlPlane` are exported type aliases over
  `TaskAuthorization`/`InferenceLease`/`ActionReservation`/`RampGateway`,
  toward the pivot's newer nouns. Field names (`allowance`/`spent`/
  `pending`) are unchanged so far — a full field-level rename
  (`allowance`→`authorizedUsd` etc.) is real, mechanical, whole-repo-touching
  work staged separately; see `docs/PIVOT_AUDIT.md` §8.4.
- **Bearer credentials** — opaque `scrip_<random>` strings, SHA-256
  hashed at rest, compared with `timingSafeEqual`. A caller never sees
  another lease's credential; `authenticate()` is the only place a raw
  credential is ever looked up.

Two bounds, both configurable per Ramp budget in `scrip.yaml`:

- **`maxDelegationDepth`** — a hard ceiling on how many levels deep
  `delegate()` can go, independent of remaining budget. Money alone can't
  stop a runaway recursive-spawn bug; this does.
- **`minRequestInputTokens`/`minRequestOutputTokens`** — computed against
  the budget's cheapest allowed model into a minimum-viable-allowance
  floor. `delegate()` rejects a slice too small to afford even one
  meaningful call, so depth is also economically curtailed: a larger task
  budget can delegate deeper than a tiny one before hitting this.

Neither bound touches the atomic reservation math (`available =
parent.allowance - parent.spent - parent.pending - delegated`) — a child
can never receive more than its parent genuinely has left, with or
without these checks.

**Persistence:** in-memory (`Map`s) by default — true for every
long-running caller (the MCP server, demo scripts). `TaskAuthorizationManager`'s
constructor takes an optional third `storePath` argument; when set, every
mutating call also serializes state to that JSON file (same pattern as
`LocalReceiptStore`) and reloads it on construction. Only the CLI opts
into this (`bin/cli.ts` passes `SCRIP_LEASE_STORE`, default
`.scrip/leases.json`) because each CLI command is a fresh process and
`authorize`/`settle`/etc. need to chain across separate invocations.

### Provider enforcement and the multi-provider abstraction

`src/proxy.ts` owns `ScripClient.run()`:

1. Resolves the model (`options.model` or `BudgetRouter.route()`, which
   picks the priciest allowed model that still fits the remaining
   budget — see `src/router.ts`).
2. Derives a conservative input-token ceiling from message byte length
   (a caller's own token estimate is never trusted as a security
   boundary).
3. Reserves the maximum possible cost via `reserveRequest`.
4. On `SpendLimitExceededError`: `onLimit: 'degrade'` retries once at
   `fallbackModel`; `onLimit: 'request-approval'` invokes the approval
   controller (below); `onLimit: 'deny'` (or anything else) propagates
   the error unchanged.
5. Dispatches to a `ModelProvider` (`src/providers/model-provider.ts`)
   resolved via `getModelPrice(model).provider` — `'anthropic'` or
   `'openai'` — and commits real token usage.

`ModelProvider` is two methods: `createMessage` (plain inference) and
`renderVerdict` (forced-structured-output, used only by the approval
controller). `AnthropicProvider` (`src/providers/anthropic-provider.ts`)
and `OpenAIProvider` (`src/providers/openai-provider.ts`) each wrap their
real SDK's tool-calling convention underneath that same interface —
callers never see either SDK's shape. `ScripClient` and
`ApprovalController` both take a `Record<'anthropic' | 'openai',
ModelProvider>` and never import an SDK type directly. `ModelPrice`
(`src/pricing.ts`, `src/pricing/model_price.json`) carries a `provider`
tag per model so routing a model name to a real client needs no separate
config.

### Evidence-based approval controller

`src/approval-controller.ts` owns `ApprovalController`, built directly
from Ramp's own published research on agent-budget approval: letting the
same agent doing the work also decide whether to keep spending fails
badly (self-graded approval hit ~97% approve regardless of framing,
self-attribution bias). What worked: a **separate model with no stake in
the outcome**, shown only a structured evidence snapshot — never the
worker's own chat history or self-justification — that renders a scored,
numeric probability verdict via a forced tool call
(`render_verdict`/`successProbability`/`reasoning`). There's no free-text
"advice" field in `TaskEvidenceSnapshot` a recommendation could hide in,
because unverified advice bundled into the prompt swung tested-controller
accuracy from near-perfect to worse-than-random in Ramp's research.

Flow when `ScripClient` hits `onLimit: 'request-approval'`:
`TaskAuthorizationManager.getEvidenceSnapshot()` builds the snapshot
(task description, allowance/spent/pending, request count, child-agent
count, elapsed time, per-model usage, the requested shortfall) →
`ApprovalController.evaluate()` calls the configured `controllerModel`
→ approved grants exactly the shortfall via `grantAdditionalAllowance`
and retries the reservation; denied throws `ApprovalRequiredError`. One
verdict is cached per task (`authorizationId`) — a denied task fails fast
on every later attempt instead of re-invoking (and re-paying for) the
controller. The controller's own call cost is never charged to the
task's own budget — billing it to the budget it's gatekeeping would be
circular.

### Real Ramp integration

`src/store.ts` defines `RampGateway`: `getReportedSpend(rampBudgetId)`
reads policy, `reportTaskUsage(receipt)` reports settled usage.
`MockRampGateway` (local-only, for tests/demos) and `RampApiGateway`
(real) both implement it; `src/runtime.ts`'s `createRampGateway()` picks
`RampApiGateway` when `RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` env vars are
present, else `MockRampGateway`.

- **`src/ramp-oauth.ts`** — `RampOAuthClient`: real client-credentials
  OAuth via HTTP Basic Auth against `/developer/v1/token`, token caching.
  Requires an explicit `scope` param — omitting it returns a valid-looking
  but scopeless token that 403s everywhere (a real gotcha hit and fixed
  during live testing).
- **`src/ramp-api-gateway.ts`** — `RampApiGateway`: reads real Fund
  balances (`GET /developer/v1/funds/{id}`, confirmed live schema),
  resolves the `rampBudgetId` label used everywhere else in the system to
  a real Fund UUID via a `fundIdsByBudget` map (only this class knows
  that identifier space exists — everything else only ever sees the
  label). Writes always go to `LocalReceiptStore` first (source of
  truth), then best-effort broadcast via an optional injected `Meter` — a
  failed broadcast is logged and swallowed, never thrown, since the money
  is already committed by that point.
- **`src/meter.ts`** — `Meter`: broadcasts settled usage to Ramp's AI
  Usage Tracking (`POST /developer/v1/ai-usage/unified`), confirmed via
  Ramp's own assistant to be the standard, provider-neutral ingestion
  path for third-party platforms (not OpenRouter's separate partner-only
  OTLP endpoint). Reuses the same OAuth app as the read side, scoped to
  `ai_usage:write`. `usage.meters: []` is required on every event — Ramp's
  own docs describe it as optional, but a real `400` proved otherwise.

Full confirmed request/response shapes, real Fund IDs in the sandbox, and
every live-verified gotcha are in `docs/ramp-api-notes.md`.

Ramp remains the system of record for company money, spend policy, agent
identities, cards, and provider-spend visibility. Scrip owns task
identity, worker hierarchy, atomic reservations, attenuated delegation,
active-task revocation, and outcome-backed settlement — it integrates
through the `RampGateway`/`FinanceControlPlane` boundary rather than
recreating any of what Ramp already owns.

### Outcome verification

`src/outcome-verifier.ts` defines `OutcomeVerifier<Request>` —
`{ type: string; verify(request): Promise<OutcomeEvidence> }` —
provider-neutral, for attaching *deterministic* evidence to a settlement
rather than asking a model to declare success from its own narrative.
`src/verifiers/github-pr-verifier.ts`'s `GithubPrOutcomeVerifier` checks
real GitHub state: `GET /repos/{owner}/{repo}/pulls/{pull_number}` for
merged status and base branch, `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
for named CI checks' `status`/`conclusion` — endpoint paths and field
names confirmed against GitHub's current REST docs. Unit-tested with a
fake `fetch` only (no `GITHUB_TOKEN` configured in this environment, so
not yet live-verified against a real repository — same honesty standard
as everything else marked "not yet live-verified" in this document).

Deliberately distinct from `ApprovalController`: that judges *mid-task
continuation* from the worker's own progress snapshot; this verifies a
*finished outcome* from external, non-self-reported state.
`TaskReceipt.evidenceDetail?: OutcomeEvidence[]` carries this onto the
receipt via `settleTask()`'s optional third argument, set before the
receipt is reported (not mutated on afterward).

### Interfaces

Three thin surfaces over the same core, none of them containing business
logic:

- **`src/handlers.ts`** — transport-independent operations
  (`getBudgetPolicy`, `authorizeTask`, `delegateTaskAllowance`,
  `settleTask`, `revokeTask`), each a near-direct call into
  `TaskAuthorizationManager`/`ScripRuntime`.
- **`src/mcp-server.ts`** / **`bin/mcp-server.ts`** — wraps 4 of those 5
  handlers (`revokeTask` isn't exposed here) as MCP tools
  (`get_ramp_budget_policy`, `authorize_ai_task`, `delegate_task_allowance`,
  `settle_ai_task`) for an MCP-capable agent harness (Claude Code, Codex)
  to call directly. **Important:** the gated inference call itself
  (`ScripClient.run`) is not an MCP tool — an MCP agent can get a
  credential over MCP, but actually spending against it still requires
  code that constructs a `ScripClient` wrapping a real provider client in
  its own process.
- **`src/cli.ts`** / **`bin/cli.ts`** — `scrip <noun> <verb> ...` for a
  human operator at a terminal: `budget status`; `task
  authorize|delegate|show|tree|settle|revoke`; `action
  reserve|commit|cancel`; `receipt show|export`. `src/cli.ts` exports a
  pure, fully-tested `runCli(runtime, argv): Promise<string>`; `bin/cli.ts`
  is the thin bootstrap (env loading, `ScripRuntime` construction,
  printing). This is the surface that needed lease persistence (above)
  since each invocation is a separate process. `task show`/`task tree`
  read `TaskAuthorizationManager.getAuthorization()`/`getLeaseTree()`
  directly; `receipt show`/`receipt export` read back through
  `RampGateway.getReceipt()` (the local write, even against
  `RampApiGateway` — Ramp's AI Usage Tracking is a one-way broadcast, not
  a queryable store).

`src/runtime.ts`'s `ScripRuntime` is the composition root all three
surfaces build on: loads `scrip.yaml` via `src/config.ts`, picks a
`RampGateway`, constructs `TaskAuthorizationManager`, owns a
`BudgetRouter`.

## End-to-end flow

```text
Caller selects budget + task allowance
→ TaskAuthorizationManager validates real Ramp Fund policy and reserves allowance
→ root agent receives a temporary credential (lease depth 0)
→ root delegates smaller credentials to child agents (depth + 1 each,
  bounded by maxDelegationDepth and the minimum-viable-allowance floor)
→ ScripClient computes the provider request ceiling, resolves a
  ModelProvider (Anthropic or OpenAI) by model name
→ TaskAuthorizationManager reserves it against lease + task
  (on failure: degrade retries once at the fallback model;
   request-approval invokes ApprovalController on a structured evidence
   snapshot, no worker self-report; deny throws)
→ real provider request executes
→ actual tokens replace the pending reservation
→ settleTask closes every lease and aggregates one receipt
  (modelUsage broken down per model, actionUsage per action type)
→ RampGateway reports task usage: local receipt first (source of truth),
  then best-effort broadcast to Ramp's AI Usage Tracking
```

## Failure propagation

- Invalid, expired, settled, or revoked credentials fail before provider I/O.
- Disallowed models and unaffordable request ceilings fail before provider
  I/O, subject to the `onLimit` policy above.
- Delegation past `maxDelegationDepth` or below the minimum-viable-allowance
  floor fails before a child credential is ever minted.
- Provider errors release pending reservations and propagate to the caller.
- Settlement and revocation both reject while a request is in flight.
- A provider response above its preauthorized ceiling is rejected and not
  charged to the task receipt.
- A denied approval-controller verdict is cached per task — never
  re-evaluated, never re-billed.

## Testing philosophy

Dependency injection everywhere a real external system is involved: fake
HTTP/SDK clients matching the real SDKs' shapes for Anthropic, OpenAI,
Ramp's OAuth/Funds/AI-Usage-Tracking endpoints, and GitHub's REST API. No
test calls a real external API. Real-API verification instead happens via
standalone `scripts/smoke-test-*.ts` scripts, run manually with real
credentials in `.env`, and by literally running the demos
(`demo/run-demo.ts`, `scripts/demo-flagship.ts`) against the real
sandbox — both approaches have caught real bugs unit tests with fakes
couldn't (a double Fund-ID resolution bug, a required-but-undocumented
`usage.meters` field, and a demo budget that didn't actually allow the
model it tried to route to).

## Known gaps / deliberately out of scope

Per the pivot instruction's own principle — don't claim unbuilt
functionality — these are genuinely not built, not "designed but
basically done":

- **Persistence beyond the CLI's opt-in JSON file** — no transactional
  store, no idempotency keys, no expiry cleanup daemon, no Postgres
  adapter. The MCP server and demo scripts are still purely in-memory per
  process. Two independent processes reserving against the same task
  would race today; nothing in this repo prevents that except the CLI's
  single-JSON-file serialization, which is not a concurrency-safe store.
- **No hosted HTTP gateway** — everything here runs as a library/CLI/MCP
  server a caller embeds or runs locally, not a multi-tenant service.
- **No Agent Card purchase flow / `TaskCostEstimator`** — scoped out
  earlier as a separate, larger surface (real-time per-purchase spend,
  not metered inference).
- **No MPP/x402 machine-payment rails.**
- **Gemini or other model providers** — the `ModelProvider` interface
  supports adding them the same way `OpenAIProvider` was added, but only
  Anthropic and OpenAI are implemented.
- **No streaming, no cross-provider failover** (only within-provider
  degrade-to-fallback exists).
- **`GithubPrOutcomeVerifier` is the only `OutcomeVerifier`** — no other
  verifier type exists.

See `docs/PIVOT_AUDIT.md` for the full classification and proposed
sequence for closing these.
