# Scrip Architecture

## Persistent agent identity and version-bound authority

Implements `SPEC.md` "Persistent agent identity and version-bound authority".
Runs in the same Node process as the mission slice, with its own SQLite
database and no network access. No new npm dependency: `node:sqlite` and
`node:crypto` only.

File ownership:

- `src/missions/agent-identity.ts`: domain types and pure functions -
  `AgentManifest`, `AgentLineage`, `AgentVersion`, `FinancialMandate`,
  `AttestationLevel`, `canonicalManifest()`, `manifestDigest()`,
  `classifyManifestChange()`, `strictestTransition()`, and constant-time
  `secretMatches()`. No I/O.
- `src/missions/agent-registry.ts`: `SqliteAgentRegistry` owns persistence
  and the authentication/authorization boundary - `registerLineage()`,
  `registerVersion()`, `registerSuccessor()`, `issueCredential()`,
  `rotateCredential()`, `authenticate()`, `createMandate()`,
  `approveMandateChange()`, `revokeVersion()`, `revokeMandate()`,
  `changeOperator()`, `verifyManifestIntegrity()`, `authorize()`.
- `src/missions/purchase-mission-service.ts`: `checkAuthority()` and
  `recordAuthorityRefusal()`; `approve()` takes an optional agent binding,
  `execute()` an optional `AuthenticatedAgent`.
- `src/missions/types.ts`: optional agent fields on `MandateEvidence`,
  `PurchaseOperation`, and `MissionReceipt`; two new event types.

```text
registerLineage(owner, operator)          → AgentLineage (history, not permission)
→ registerVersion(manifest)               → immutable AgentVersion + manifestDigest
→ issueCredential(lineage, version)       → secret returned once, stored hashed
→ createMandate(contractDigest, versions) → explicit authorizedVersionIds allow-list
→ approve(..., binding)                   → MandateEvidence carries lineage/version/mandate
→ execute(..., authenticate(id, secret))
   → checkAuthority('pre_reservation')    → before claimOperation/reserveAction
   → payments.issue()
   → checkAuthority('pre_dispatch')       → immediately before execution.start()
   → getReceipt()                         → agentVersionId + attestationLevel
```

Two authority checks exist because revocation can race an in-flight
operation. The pre-dispatch check runs after the payment capability is
issued and before the execution provider is called; a refusal there stops
dispatch, releases authority via `stopAuthority()`, and reconciles. Once
`execution.start()` has been called, revocation cannot retract it, and
`reconcile()` settles that operation under its original version.

Authority refusals are appended in a separate transaction
(`recordAuthorityRefusal()`) because the pre-reservation check runs inside
the mission transaction, and throwing rolls it back - which would discard
the audit record of the denied attempt.

**Assurance limitation.** `attestationLevel` is always `self_declared`.
The manifest digest detects alteration of the *record*; it does not prove
what software executed. Nothing here observes the running process. The
`signed_release` and `runtime_attested` levels are reserved and unissuable.
Mutable model aliases are flagged via `modelIsMutableAlias`: an upstream
weight change is unobservable here and is a recorded limitation, not a
defended-against threat.

**Change policy.** `classifyManifestChange()` never returns `display_only`
for a code or dependency change - `codeArtifact` maps to `unknown_effect` /
`require_review`, so a "patch" label earns no exemption. Model, instruction,
policy, tool-loss and gained-permission changes pause spending pending
approval. A successor version inherits no authority: it is never added to
any mandate's `authorizedVersionIds` without explicit re-approval.

## Consumer hotel mission slice

`SPEC.md` and `IMPLEMENTATION_BRIEF.md` now define the consumer direction.
The older platform description below remains a map of the existing engine;
the first consumer slice is an application service with fake provider tests,
not a deployed wallet.

All new code runs in Node. It requires `node:sqlite` (use Node 24 or newer;
verified here on Node 25.1.0, which emits an experimental SQLite warning).
There is no new npm dependency. `createRequire()` loads this native module
because the repository's Vite/Vitest version does not recognize its static
built-in import. Existing Zod validates runtime input; Node crypto hashes the
complete deterministic rendered contract and scoped operation key.

File ownership:

- `src/missions/types.ts`: hotel quote, versioned `OutcomeContract`, mission,
  attributed evidence, recovery policy, receipt, and provider interfaces.
- `src/missions/outcome-assessor.ts`: input schemas, `renderContract()`,
  exact-quote `preflight()`, independent `assessOutcome()`, payment totals.
- `src/missions/mission-store.ts`: `SqliteMissionStore`, append-only event
  storage, `projectMission()`, optimistic revision checks, unique operation
  claims, and the transactional adapter for existing lease state.
- `src/missions/purchase-mission-service.ts`: `PurchaseMissionService`
  coordinates approval, reservations, provider calls, evidence, recovery,
  cancellation, and receipts. It uses a local-only `RampGateway` for budget
  accounting and task receipts; no environment-selected live adapters.
- `src/lease.ts`: optional `LeaseStateStore` injection, preserving the
  existing reservation math and JSON/in-memory defaults. The optional
  `revokeTask(id, { preservePending: true })` disables the full lease tree
  without cancelling an unknown payment's hold; later commit/cancel can
  still reconcile that reservation. Default revocation behavior is unchanged.

```text
create(consumerId, typed hotel terms)
→ contract_created event → draft PurchaseMission
→ renderApproval() → consumer approves exact version + summary hash
→ approve() records the immutable mandate
→ execute() checks ownership, expiry, hard constraints, and the exact quote
→ SQLite transaction claims the consumer/mission/version/purchase key
→ TaskAuthorizationManager.authorizeTask() creates the root
→ reserveAction() reserves maximumTotal; events and lease state commit together
→ PaymentCapabilityProvider.issue() receives exact quote, cap, expiry, singleUse
→ ExecutionProvider.start() receives the capability reference
→ reconcile() polls payment facts and independently attributed booking evidence
→ recordPaymentFact() appends capture and commitAction() in one transaction
→ verify() assesses the booking and capture, then settleTask() emits a local receipt
→ permitted requestRecovery() records intent before merchant recovery I/O
→ merchant acknowledgment remains refund_pending
→ payment-provider refund facts update receipt totals, retaining original capture
```

Approval records the mandate; the root authorization is created lazily in
the execution transaction so raw lease credentials need never be persisted
or returned by this service. Before execution, `revise()` appends a new
version and removes current approval while retaining the prior version.
Once execution has started, revisions require a separate mission. No retry
creates another purchase, including after an unpaid failure or a crash before
the first provider call. Such retries only poll the original operation key.

SQLite `BEGIN IMMEDIATE`, a unique `(mission_id, contract_version, operation)`
constraint, and a unique operation key enforce ownership of each operation.
Financial state remains the existing `TaskAuthorizationManager` snapshot,
stored in the same SQLite transaction as events and local task receipts.
The local gateway also counts revoked tasks' pending holds and captured spend,
so revocation cannot make ambiguous money available to another mission.
The service reconstructs the manager inside each transaction, avoiding stale
process-local snapshots across connections. External provider calls run after
commit, outside the database transaction. A concurrent writer receives a
retryable `MissionConflictError`; callers retry the same request. SQLite
releases locks after process death. Production scale would require a separate
storage decision: each write currently serializes the complete lease snapshot.

Financial receipt meanings: `authorized` is the approved mandate ceiling;
`reserved` is the actual remaining lease hold; `captured`, `reversed`, and
`refunded` are separate payment facts; `returned` is unused authorization
released when authority closes, not a refund; `netSpend` subtracts posted
refunds/reversals from captures; `unrecovered` is that net spend when failure,
recovery, or revocation leaves money outstanding. Refund acknowledgment never
increases `refunded`. Task receipts are settlement-time artifacts; later
evidence and recovery update the mission receipt, without rewriting them.

Provider boundaries and remaining gaps:

- `ExecutionProvider` and `PaymentCapabilityProvider` are local interfaces;
  `FakeHotel` in `tests/purchase-mission-service.test.ts` implements the full
  reference scenario. No merchant, payment, Kernel, or Ramp integration was
  added. Stop/revoke must be idempotent by operation key, including when a
  provider reference was lost to a timeout; providers must honor single use,
  exact quote scope, and revocation tombstones during issuance races.
- Unknown payment results retain the hold. Only authoritative terminal unpaid
  evidence releases it. Invalid/out-of-scope facts are rejected for review;
  out-of-order recovery facts must be retried after capture is available.
- Merchant/email facts are accepted only through trusted application adapter
  methods. There is no signature verification or consumer authentication
  transport yet; the service checks ownership against the supplied identity.
  Agent prose is recorded separately and cannot satisfy verification.
- Cancellation/refund requests are supported. Replacement/rebooking and all
  dispute submission are rejected. Exact dispute confirmation and submission
  are deferred, so no unattended dispute path exists.
- No HTTP routes, consumer UI, production runtime composition, automatic
  polling scheduler, production deployment, or live-money verification.
  Existing CLI/MCP/HTTP/JSON storage is not migrated to the SQLite store.
- A refund/reversal is modeled as a posted credit against a prior capture;
  this slice does not implement pre-capture authorization-void reconciliation.

`npx vitest run tests/purchase-mission-service.test.ts` exercises the complete
fake flow, independent SQLite connections, transactional rollback, and a real
subprocess exit at the provider boundary. `npm run build`, `npx tsc --noEmit`,
and `npm test` remain the repository checks when `.claude/checks.sh` is absent.

> **Mid-pivot.** This repo is moving from an inference-budget prototype
> toward a broader execution-economics platform for autonomous work. The
> domain mechanism described below (atomic reserve/commit/cancel over any
> action type, not just inference) was already generalized before the
> pivot began, the CLI has since been reshaped around task/action/receipt
> nouns, a hosted HTTP API exists and is tested, and a real
> concurrency-safe Postgres store exists and is proven against a live
> database — see `docs/PIVOT_AUDIT.md` for the full classification of
> what's built, what's built-but-not-integrated, and what's genuinely
> not started (`PostgresTaskStore` isn't wired in as
> `TaskAuthorizationManager`'s backend yet).

## Deterministic authorization demo

`demo/deterministic-authorization.ts` (`npm run demo:deterministic`) runs
the three-phase structure end to end against in-process fake providers,
with both SQLite files in a temp directory deleted on exit. No network.

```text
PROPOSE  scripted extraction → ContractInput with one unresolved constraint
         → PurchaseMissionService.create() → approve() refused ("Unresolved
           hard constraints") → revise() to v2
RATIFY   renderApproval() → sha256 → SqliteAgentRegistry.registerLineage /
         registerVersion / issueCredential / createMandate(outcomeContractDigest)
         → approve(binding)
ENFORCE  evaluatePreflight(wrong dates) → refused; FakeProviders.issueCalls === 0
         execute(forged secret) → AgentAuthenticationError
         execute(exact, real credential) → reconcile() → assessOutcome success
         second mission, merchant reports failed → failure, unrecovered 500
         → requestRecovery('refund') → postRefund → reconcile → unrecovered 0
```

`runDemo(log)` is exported so `tests/demo-deterministic.test.ts` can run the
same script silently and assert the provider call counts and assessments.
The demo owns no logic: everything it shows is the mission slice and the
registry behaving as documented above. `FakeProviders` in the demo file
stands in for a payment rail and a merchant, and its `mode` switch is what
produces the paid-but-not-delivered scenario.

## Purchase-protection demo: card slice, recovery case, live Natural money leg

`demo/protect.ts` (`npm run demo:protect`) and `visuals/protect-server.ts`
(`npm run visuals:protect`, one page at `visuals/protect.html` fed by
server-sent events). One flow, approve -> authorize -> verify -> recover,
on the existing hotel mission. `PurchaseMissionService`, the assessor, the
registry, and `lease.ts` are unchanged. All rail-side actors are labeled
SIMULATED in their type names and on the page.

File ownership:

- `src/cards/types.ts`: `CardBinding` (what an issuer stores at issuance:
  merchant id and descriptors, ceiling, exact total, window, single-use
  status, and `purchaseDigest = sha256(canonical(contract.purchase))`),
  `SignedMerchantOrder`, `CardAuthorizationRequest`, `CardAuthorizationDecision`.
- `src/cards/card-gate.ts`: pure. `authorizeCard()` is the authorization
  tier (merchant descriptor, amount, currency, window, single use);
  `verifyMerchantOrder()` is the order tier (HMAC signature, recomputed
  digest, equality with the binding's digest, exact amount). It imports
  nothing from the mission service, registry, or store; a test in
  `tests/card-gate.test.ts` enforces that boundary by reading the imports.
  The gate only ever sees what was stamped on the binding, because that is
  the only channel a real issuer has.
- `src/cards/simulated-rail.ts`: `SimulatedIssuer` (holds bindings, runs the
  gate, captures, refunds, logs every decision; a declined authorization
  produces no payment fact because nothing moved), `SimulatedAcceptMerchant`
  (sends a signed order with each authorization; fulfillment via merchant
  API), `SimulatedWebMerchant` (no order; fulfillment arrives later as a
  parsed confirmation email).
- `src/cards/card-payments.ts`: `CardPaymentCapabilityProvider` adapts the
  issuer to the existing `PaymentCapabilityProvider`; the capability handed
  to the agent is a card reference. The binding's digest is computed from
  the `ExecutionRequest` booking, which `execute()` only builds after
  `preflight()` proved it canonically equal to the approved purchase.
- `src/protect/recovery-case.ts`: `buildEvidencePacket()` (approved
  contract hash, purchase digest, agent version, payment facts, fulfillment
  evidence, per-field mismatches, money position) and `openRecoveryCase()`
  (appends `recovery_case_opened`; asks the merchant for a refund through
  the existing `requestRecovery()` only where the approved policy allows).
  It never decides fault and never files a dispute.
- `src/rails/natural-settlement.ts`: `NaturalSettlementProvider` wraps the
  simulated card provider. Natural has no card product, so it sits on the
  money-facts boundary only: each simulated capture becomes a real $1.00
  wallet-to-wallet transfer on the account behind `NATURAL_API_KEY`, tagged
  with the purchase digest and operation key, and the ledger's payment fact
  carries Natural's transfer id. Refunds are the reverse transfer; a run
  starts by sweeping the simulated-merchant wallet back so it nets to zero.
  Enabled by `SCRIP_RAIL=natural`. It is an evaluation of how the layer sits
  on Natural's rail, not a product built on it.

```text
approve   person approves contract -> renderContract() hash + purchaseDigest()
          registry: lineage/version/credential/mandate bound to the hash
authorize execute() -> preflight() on the agent's candidate -> claim + reserve
          -> CardPaymentCapabilityProvider.issue() -> SimulatedIssuer.issue(binding)
          -> SimulatedCheckout.start() -> merchant.checkout(cardRef, what it sells)
          -> SimulatedIssuer.authorize() -> authorizeCard() [+ verifyMerchantOrder()]
          -> approve: capture (+ live Natural transfer when SCRIP_RAIL=natural)
          -> decline: no fact; operator cancels the mission
verify    reconcile() -> getFacts() + getEvidence() -> assessOutcome()
recover   openRecoveryCase() -> packet -> requestRecovery('refund') -> refund_pending
          -> issuer.refund() [+ live reverse transfer] -> reconcile() -> unrecovered 0
```

Why the gate takes a digest and not the contract: a real issuer would not
hold the consumer's contract, only what was bound at issuance. The cost is
that the gate cannot say which field differed; the assessor, on Scrip's
side, does. Why the purchase digest is distinct from the contract hash: a
merchant can only hash the order it sees, so `renderContract().hash` (goal,
constraints, policy) and `purchaseDigest()` (the booking alone) are two
different fingerprints and must not be conflated.

## What this is

Scrip connects what a person authorizes an agent to buy with what the agent
actually pays for and what was delivered. The current product surface is the
mission slice (`src/missions/`), the card slice (`src/cards/`), the recovery
case (`src/protect/`), and the live Natural money leg (`src/rails/`),
described in the sections above. Underneath them is the task ledger
(`src/lease.ts`, `src/store.ts`): atomic reserve/commit/cancel accounting for
one authorized job and its delegated workers, with a CLI, HTTP API, and MCP
server over it. The ledger predates the purchase work and is what the mission
slice uses to reserve and settle exposure.

Stack: TypeScript/Node, ESM (`"type": "module"`), Vitest, `js-yaml` for
config, real `@anthropic-ai/sdk` and `openai` SDKs, `@modelcontextprotocol/sdk`
for the MCP surface.

## Runtime boundaries

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

### Finance boundary

`src/store.ts` defines `RampGateway` (aliased `FinanceControlPlane`): the
two calls the ledger makes outward, `getReportedSpend(budgetId)` to learn
what a budget has already spent this month, and `reportTaskUsage(receipt)`
to record a settled receipt. `MockRampGateway` is the only implementation:
a local JSON-file receipt store. `src/runtime.ts`'s `createRampGateway()`
returns it. The Ramp API integration that used to sit here (OAuth, Fund
reads, usage broadcast, card issuance, x402) was removed on 2026-09-21; the
design notes for it are under `docs/archive/`.

The one live rail in the repo, `src/rails/natural-settlement.ts`, does not
attach here. It attaches at the mission slice's `PaymentCapabilityProvider`
boundary, because that is where a payment fact enters the ledger, and it
records Natural's transfer id as that fact.

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
- **`src/interfaces/http/server.ts`** / **`bin/http-server.ts`** — a
  fourth thin surface, same principle as the other three: `createHttpServer(runtime)`
  builds an Express app whose routes each call one `src/handlers.ts`
  function and translate its result/error into an HTTP response and
  status code (`InvalidCredentialError`→401, `ApprovalRequiredError`→403,
  `SpendLimitExceededError`→402, unknown-lookup errors→404, everything
  else→400). Credentials travel as `Authorization: Bearer <credential>`.
  Tested with real HTTP requests over a real TCP connection
  (`server.listen(0)` + Node's built-in `fetch`), not a mocked Express
  instance. Carries no authentication/authorization layer of its own by
  design — that's a deployment-time concern, not this surface's job.

`src/runtime.ts`'s `ScripRuntime` is the composition root all four
surfaces build on: loads `scrip.yaml` via `src/config.ts`, picks a
`RampGateway`, constructs `TaskAuthorizationManager`, owns a
`BudgetRouter`.

### Durable, concurrency-safe persistence

`src/infrastructure/postgres/postgres-task-store.ts`'s `PostgresTaskStore`
is a real, independent implementation of the authorize/reserve/commit/cancel
primitive backed by Postgres transactions and `SELECT ... FOR UPDATE` row
locks on both the lease and task-authorization rows — the property a
process-local `Map` cannot offer: two separate connections (simulating
two separate processes) racing to reserve against the same remaining
balance can never both succeed when only one fits. Supports
idempotency-key-safe retries (`action_reservations`'s unique index on
`metadata->>'idempotencyKey'`), a real requirement for a durable store
that an in-memory Map never had to solve.

Proven with a live test (`tests/postgres-task-store.test.ts`) against a
real Postgres, not asserted from the schema alone — including a test
that fires two concurrent reservations from two separate `pg.Pool`
instances and asserts exactly one wins. Tests skip cleanly (not fail)
when no Postgres is reachable at `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`.

**Not yet wired in as `TaskAuthorizationManager`'s backend.**
`TaskAuthorizationManager`'s public API is synchronous in several places
(`delegate`, `reserveAction`, `commitAction`, `cancelAction`,
`getAuthorization`, ...), used throughout every other surface in this
document and 121 existing tests; swapping its backend to something
async is a real, separate integration decision this repo hasn't made.
`PostgresTaskStore` stands on its own today, proving the mechanism for
real ahead of that integration.

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

Dependency injection everywhere a real *external* system is involved: fake
HTTP/SDK clients matching the real SDKs' shapes for Anthropic, OpenAI,
Ramp's OAuth/Funds/AI-Usage-Tracking endpoints, and GitHub's REST API. No
test calls a real external API. Real-API verification instead happens via
standalone `scripts/smoke-test-*.ts` scripts, run manually with real
credentials in `.env`, and by literally running the demos
(`demo/run-demo.ts`, `scripts/demo-flagship.ts`) against the real
sandbox — both approaches have caught real bugs unit tests with fakes
couldn't (a double Fund-ID resolution bug, a required-but-undocumented
`usage.meters` field, a demo budget that didn't actually allow the model
it tried to route to, and two runtime assets missing from the compiled
`dist/` output that only surfaced by actually running it).

Two exceptions, deliberate: `tests/postgres-task-store.test.ts` and parts
of `tests/http-server.test.ts` exercise real infrastructure this project
controls rather than a third party - a real local Postgres and a real
TCP server on an ephemeral port, respectively. Neither is a "real
external API" in the sense above (no third-party credentials, no
network egress, nothing another team owns); they're testing this
project's own concurrency and HTTP-semantics guarantees, which fakes
cannot actually prove. The Postgres tests skip cleanly when no database
is reachable, so `npm test` stays fully offline-runnable for anyone
without one.

## Known gaps / deliberately out of scope

Per the pivot instruction's own principle — don't claim unbuilt
functionality — these are genuinely not built, not "designed but
basically done":

- **`PostgresTaskStore` is real and proven, but not `TaskAuthorizationManager`'s
  backend.** The engine every other surface (CLI, MCP, HTTP, demos) talks
  to still holds state in-memory, with the CLI's own opt-in
  single-JSON-file persistence for cross-invocation chaining — not
  concurrency-safe the way the Postgres store is. Two independent
  processes reserving against the same task via `TaskAuthorizationManager`
  would still race today; the mechanism that prevents that exists and is
  tested, it's just not plugged in yet.
- **No idempotency-key support outside `PostgresTaskStore`** — the CLI,
  HTTP API, and MCP server have no retry-safety of their own.
- **No self-scheduling expiry-cleanup daemon.** `TaskAuthorizationManager.sweepExpired()`
  (`scrip task sweep-expired`) closes the actual gap this used to describe -
  a task whose worker crashed or never returned used to leave its
  authorization `active` forever with its in-flight reservation's money
  stuck in `pending`, unrecoverable by any caller. `sweepExpired()` cancels
  every reservation still `reserved` under each authorization already past
  `expiresAt`, releasing that `pending` amount through the normal
  `cancelAction` path, then revokes the authorization and its leases -
  unit-tested (`tests/lease.test.ts`) against a manually expired
  authorization with a reservation stuck mid-flight. What's still missing
  is only the *scheduling* - nothing in this repo invokes it periodically
  yet; that's an external cron/scheduled-Lambda decision, same as
  `PostgresTaskStore`'s live concurrency proof existing without being
  wired into `TaskAuthorizationManager` as its backend.
- **The HTTP API has no authentication/authorization layer** — by
  design, not oversight (see `src/interfaces/http/server.ts`'s own
  comment), but genuinely absent, so it isn't safe to expose publicly
  without one.
- ~~**The `Dockerfile` has not been through `docker build`**~~ — closed
  2026-08-01: a real Docker daemon became reachable, and both
  `docker build` and `docker compose up --build` were run live. Found and
  fixed a real bug in the process — see the Dockerfile's own comment on
  the `/data` volume permission fix.
- **No pre-purchase cost estimation surface.** The card path in the
  purchase-protection demo binds a single-use card to an approved record via
  a simulated issuer (`src/cards/simulated-rail.ts`); no real card issuer is
  wired in.
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
