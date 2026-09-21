# Agent Financial Sandbox

**Date:** August 28, 2026  
**Status:** Proposed design  
**Product:** Scrip  
**Assumption:** A human principal funds one task and delegates a bounded financial sandbox to an agent. The agent receives the task-scoped card and other paid capabilities. No human worker is hired.

## 1. Summary

Scrip lets a human place one agent task inside a temporary, real-money financial environment. The environment holds a fixed budget, issues the agent a constrained card and paid capabilities, records every reservation and charge, and closes when the task settles.

The developer-facing promise is:

> Give an agent money for one job without giving it your wallet. Scrip creates the sandbox, enforces the limit, and returns what the agent does not use.

Scrip does not become a bank, card issuer, payment network, or general-purpose agent wallet. Regulated providers own custody, card issuance, and money movement. Scrip owns the human-to-agent delegation contract and the task lifecycle across those primitives.

## 2. Product boundary

### Scrip owns

- The task identity and lifecycle.
- The allocation of a total task budget across card purchases, paid APIs, compute, inference, and contingency.
- Attenuated authority when an agent delegates work.
- Reservations before financial actions.
- The relationship between an agent, its delegated task, and its temporary financial credentials.
- Outcome evidence and principal acceptance state.
- Settlement orchestration, unused-fund return, and one task receipt.
- Reconciliation of provider events into the task ledger.

### Financial providers own

- Custody of real funds.
- KYC, KYB, sanctions screening, and required cardholder information for the task sponsor.
- Card issuance, tokenization, authorization, clearing, refunds, and disputes.
- PCI-scoped handling of card credentials.
- Legally required account statements and financial disclosures.

### Scrip does not own in the first release

- A consumer shopping agent or marketplace.
- Merchant fulfillment, delivery, or return policies.
- A replacement for the human principal's bank account.
- Automated adjudication of subjective work.
- Lending, credit, insurance, or guaranteed refunds.
- International payouts or multi-currency tasks.
- A general consumer wallet.

### Provider strategy

The intended funding adapter is Natural because its currently published products include programmable wallets and direct money movement. Scrip uses Natural as a financial rail; it does not reproduce Natural's custody, identity, compliance, or transfer APIs.

The agent-card adapter cannot assume Natural card issuance in the first release because Natural currently marks Cards as `Soon`. The repository's existing Ramp Agent Card path is relevant because the credential is assigned to an agent, but its current tests and demos do not by themselves establish production eligibility for Scrip's delegated-sandbox use case. Before the agent-card slice begins, a provider contract test must establish all of the following with the selected issuer:

- The provider permits an agent to use the credential for the principal's approved task and merchant scope.
- The verified task sponsor remains the accountable legal customer while the credential is assigned to the agent.
- Cards support programmatic spend limits, merchant or category restrictions, expiration, freeze, and revocation.
- Authorization, capture, reversal, refund, and dispute events are queryable and delivered through signed webhooks.
- Scrip can fund the card without holding raw card credentials or operating an undisclosed stored-value balance.

Until one issuer passes that gate, the agent-card slice is `PARTIAL` and must not be represented as live. Natural's current authorized-use policy also prohibits building a product that competes with Natural using Natural's technology, so a Natural-backed release requires written confirmation that Scrip's task-sandbox layer is an approved complementary use.

Current product references:

- [Natural Wallets](https://www.natural.com/wallet)
- [Natural Pay](https://www.natural.com/pay)
- [Natural Cards](https://www.natural.com/cards)
- [Natural Authorized Use Policy](https://www.natural.com/aup)

## 3. First user and first job

The first customer is a developer building an agent that needs to spend real money while completing a bounded task. Scrip makes the human principal's delegation temporary, attenuated, revocable, and observable.

The first verified flow uses one human principal and one agent completing a small internet task:

```text
Human authorizes "buy a domain and deploy a landing page" with $50
-> $15 assigned to paid tools and inference
-> $25 assigned to permitted card purchases
-> $10 retained as contingency
-> provider issues the agent a temporary, merchant-scoped card
-> agent spends $1.20 on inference, $12 on the domain, and $5 on hosting
-> external evidence confirms the domain and deployment
-> human accepts the result
-> pending authorizations resolve
-> $31.80 returns to the human
-> card, API allowances, and task credentials are revoked
```

The initial live test should use a low budget and ordinary permitted merchants. It is a production-rail verification, not a claim that every merchant supports delayed capture or refunds. If a merchant captures before the outcome is verified, the receipt must say so.

## 4. Developer experience

The primary interface is an SDK plus agent tools. A hosted principal page shows the contract, live spend, evidence, recovery status, and final receipt. The agent receives scoped payment capabilities, not raw card details in its prompt or logs.

```ts
const task = await scrip.tasks.create({
  title: "Buy a domain and deploy a landing page",
  instructions: "Use the selected name and return the live URL.",
  budget: { amount: 50, currency: "USD" },
  card: {
    limit: 25,
    allowedMerchants: ["domain-registrar", "hosting-provider"],
  },
  paidTools: { limit: 15 },
  contingency: { amount: 10 },
  expiresAt: "2026-08-30T17:00:00-04:00",
  acceptance: { mode: "principal_review" },
});

await task.start();
```

The response includes identifiers and hosted links, never raw card credentials:

```ts
{
  taskId: "task_...",
  status: "funding_required",
  fundingUrl: "https://scrip.example/tasks/task_.../fund",
  principalUrl: "https://scrip.example/tasks/task_...",
}
```

The principal can subscribe to webhooks for task state changes, reservations, card activity, outcome evidence, refunds, disputes, and reconciliation failures.

## 5. Core domain model

### `TaskContract`

The durable statement of the job and its financial bounds:

- Human principal identity.
- Agent identity and accountable principal.
- Instructions and expiry.
- Card, paid-tool, compute, and inference allocations.
- Merchant, provider, action, and approval restrictions.
- Contingency allocation.
- Acceptance policy.
- Cancellation and recovery policy.

Terms become immutable when the agent card is issued. A material change requires the principal to approve a new version and Scrip to replace or update the card policy before the agent continues.

### `TaskSandbox`

The live financial environment associated with one funded task:

- Provider account or wallet reference.
- Funding state.
- Agent-card reference and status.
- Paid-tool and provider allowances.
- Contingency balance.
- Active provider credentials and their expiry.
- Current lifecycle status.

### `TaskParty`

An authenticated participant with one role:

- `principal`: funds the task, approves material policy changes, accepts or rejects the outcome, and receives returned funds.
- `agent`: receives task-scoped capabilities and acts only inside the delegated limits.
- `subagent`: receives an attenuated child allowance that can never exceed its parent's available authority.

### `FinancialAction`

An idempotent reserve/commit/cancel record for:

- Task funding.
- Inference, paid API, cloud compute, or card purchase.
- Card authorization and capture.
- Card reversal or refund.
- Task sweep.
- Provider fee.

Each action stores the provider, provider object ID, idempotency key, requested amount, committed amount, status, timestamps, and related task allocation.

### `TaskReceipt`

The final artifact contains:

- Original contract and accepted version.
- Total funded amount.
- Spend broken down by action type and provider.
- Card authorizations, captures, reversals, and refunds.
- Provider fees.
- Amount returned to the principal.
- Externally verified outcome evidence and principal acceptance record.
- Provider transaction references.
- Any unresolved or disputed actions.

## 6. Lifecycle

The task state machine is:

```text
draft
-> funding_required
-> funded
-> credentials_issuing
-> active
-> outcome_pending
-> accepted | rejected | cancelled
-> closing
-> settled | recovery_pending | disputed
```

### Creation and funding

1. The human or their developer creates a `TaskContract`.
2. Scrip validates that card, paid-tool, compute, inference, and contingency allocations do not exceed the total task budget.
3. Scrip creates an isolated provider-side wallet or equivalent funding container.
4. The principal funds the complete task amount before the agent receives spending authority.
5. A provider webhook confirms funds are available; client redirects alone are not trusted as financial evidence.

### Delegation and credential issuance

1. The principal reviews the goal, total budget, allocations, merchants, providers, expiry, and approval thresholds.
2. The principal approves the immutable task version.
3. Scrip creates an opaque root lease for the agent.
4. Scrip asks the card provider to issue a credential capped by the card allocation, merchant policy, and contract expiry.
5. Paid APIs and compute adapters receive separate task-scoped allowances.
6. The agent receives opaque capability handles. Scrip does not place PAN or CVV in the model prompt, transcript, logs, or general API responses.

### Agent execution and accounting

1. Every costly action reserves its maximum cost before provider or merchant I/O.
2. Provider success commits the actual cost and releases unused reservation.
3. Provider failure cancels the reservation.
4. Card authorization events create pending purchase actions; capture commits the amount and reversal cancels it.
5. A refund creates a separate recovery action and never erases the original capture.
6. Pending, committed, and delegated amounts all reduce availability, so concurrent agents cannot jointly exceed the task or subtree allocation.
7. A child agent receives a strictly attenuated lease and cannot grant itself or its descendants additional authority.

### Outcome and acceptance

1. The agent submits the claimed result and provider references.
2. Deterministic verifiers inspect external state when a verifier exists, such as a live deployment, delivered asset, or completed booking.
3. The task enters `outcome_pending`; new spending is frozen while existing authorizations can settle.
4. The first release requires explicit principal acceptance before the task closes. The working agent cannot approve its own outcome.
5. Rejection does not magically reverse captured spend; it triggers the contract's supported cancellation, refund, or dispute workflow.

### Closure and recovery

1. Scrip revokes the agent card and every descendant credential.
2. It waits for, voids, or reconciles outstanding authorizations according to the provider's rules.
3. It sweeps unused task funds back to the principal.
4. It records any refund that remains pending after closure as `recovery_pending` rather than overstating returned funds.
5. Once all required provider actions reach a terminal state, Scrip emits the final receipt and marks the task `settled`.

## 7. Accounting invariants

The existing Scrip reservation invariant remains authoritative for every allocation:

```text
available = allowance - spent - pending - delegated
```

The agent sandbox adds these requirements:

1. The sum of all allocations cannot exceed the funded task budget.
2. Card pending plus card settled spend cannot exceed the card allocation.
3. Paid-tool, compute, and inference actions cannot exceed their allocations or the root task allowance.
4. A child allocation cannot exceed its parent's available balance.
5. Provider events are append-only financial facts; refunds and reversals are separate actions.
6. A provider object ID and event ID can affect the ledger at most once.
7. A task cannot settle while a sweep or material provider action is ambiguous.
8. The amount reported as returned must equal confirmed provider-side credits, not an internal calculation alone.
9. Revocation stops future authority but does not pretend to reverse already captured transactions.

## 8. Failure and recovery semantics

### Agent never starts or task expires

Scrip revokes any issued credentials and returns all confirmed unused funds to the principal minus disclosed non-refundable provider fees.

### Principal revokes the task

The root lease and all descendants are revoked immediately. New spending stops, while captured charges and pending authorizations follow provider rules. Confirmed unused funds return after reconciliation.

### Agent produces an unacceptable outcome

The principal may reject or request a supported recovery action. The first release does not let Scrip or the working agent adjudicate subjective quality, and rejection does not imply that already captured payments are reversible.

### Payment request times out

Scrip persists `payment_pending` before contacting the provider, then queries by idempotency key or provider reference. It never retries an ambiguous real-money operation blindly.

### Captured card purchase needs recovery

Scrip may orchestrate a merchant refund or card dispute when legitimate and supported. It does not promise arbitrary clawback. A captured, non-refundable purchase remains spent.

### Provider webhook is delayed or duplicated

Signed webhooks are deduplicated by provider event ID. A scheduled reconciliation process compares every non-terminal action with provider state and repairs missed local transitions.

### Scrip process crashes

All money-related state must be durable before external I/O. Restarted processes resume from persisted actions and reconcile provider state rather than reconstructing state from memory.

## 9. Architecture and ownership

The behavior executes in four runtimes:

```text
Human-facing application or developer backend
-> creates tasks, obtains principal approval, and receives webhooks

Scrip service
-> owns task contracts, ledger, policy, orchestration, and reconciliation

Financial providers
-> own custody, principal identity verification, card issuance, transfers, and network events

Agent runtime
-> receives scoped capability handles and performs task actions
```

The implementation should extend existing boundaries rather than insert real-money logic directly into transports:

- `src/lease.ts`: preserve task, delegation, and reservation invariants until the existing domain split is completed.
- `src/store.ts` and `src/infrastructure/postgres/`: durable task, action, receipt, and idempotency records. Real-money mode must not use the in-memory store.
- `src/runtime.ts`: compose providers, stores, handlers, and reconciliation.
- `src/payment-executor.ts`: evolve from a mock-only experiment into a general external-payment boundary; keep reservation and provider execution separate.
- New `AgentCardProvider`: issue, freeze, revoke, and query task-scoped agent cards.
- New `TaskFundsProvider`: create and sweep task funding containers.
- Existing model and paid-action adapters: report estimates and actual usage through the same reservation lifecycle.
- Transport handlers: expose task operations without containing accounting policy.
- Hosted principal interface: render the contract, live spend, approval requests, recovery state, and final receipt; it never stores raw financial credentials.

Provider capabilities may come from one vendor or several. Scrip's domain consumes capability-specific interfaces so replacing a card issuer does not change task settlement logic.

## 10. Security, compliance, and authority

- Real-money mode requires the transactional Postgres store to be wired into normal runtime paths.
- Every mutating request requires an authenticated principal and a task-scoped authorization check.
- Principal, agent, and subagent credentials are separate and revocable.
- Task credentials are single-purpose, hashed at rest, and expire.
- Webhook signatures are verified against raw request bodies.
- Monetary amounts use integer minor units and an explicit currency.
- The system never logs or stores PAN, CVV, full government identifiers, or provider secrets.
- Provider secrets live in a secret manager and are rotated independently.
- The principal must review provider and task disclosures before card issuance.
- The first release is U.S.-only and restricted to provider-supported principals and permitted merchant categories.
- Public launch is blocked until counsel and providers confirm cardholder, delegation, money-transmission, liability, and dispute responsibilities.

## 11. API surface for the first release

The first release needs only these operations:

```text
POST /v1/tasks
POST /v1/tasks/:id/fund
POST /v1/tasks/:id/approve
POST /v1/tasks/:id/start
POST /v1/tasks/:id/delegations
POST /v1/tasks/:id/outcome
POST /v1/tasks/:id/accept-outcome
POST /v1/tasks/:id/reject-outcome
POST /v1/tasks/:id/cancel
GET  /v1/tasks/:id
GET  /v1/tasks/:id/receipt
POST /v1/provider-webhooks/:provider
```

Card reveal, KYC, bank details, and sensitive identity collection remain provider-hosted. Scrip endpoints return opaque capability handles, hosted links, and status; they do not return raw card details to the model.

## 12. Verification strategy

### Domain tests

- Allocation totals and integer-money arithmetic.
- Concurrent card authorizations cannot exceed the card allocation.
- Concurrent actions cannot jointly exceed the root task or child lease.
- Child allocations remain attenuated after nested settlement.
- Revocation stops future actions without rewriting committed spend.
- Refunds and reversals remain append-only actions.

### Persistence and concurrency tests

- Postgres row locking prevents cross-process overspend.
- Provider event and request idempotency survive retries and restarts.
- A crash after provider success but before local completion is repaired by reconciliation.
- Duplicate and out-of-order webhooks converge on the same ledger state.

### Provider contract tests

- Funding, agent-card issuance, freeze, revoke, sweep, refund, and query adapters against provider sandboxes.
- Raw webhook signature verification using provider fixtures.
- Explicit capability failure when an adapter cannot issue a credential for the verified principal's delegated-agent use case.

### Live verification

A feature is not called real-money complete until one bounded task demonstrates, on production financial rails:

1. Confirmed principal funding.
2. Principal identity/provider onboarding.
3. Task-scoped agent-card issuance.
4. At least one non-card paid action and one permitted card authorization and capture under the same root allowance.
5. External outcome evidence and explicit principal acceptance.
6. Root and descendant credential revocation.
7. Unused funds confirmed returned.
8. Final receipt reconciled against every provider object.

If any provider capability is unavailable, the result is `PARTIAL`; the demo must not substitute a mock while claiming the end-to-end flow passed.

## 13. Delivery sequence

The product is too broad to implement as one change. It decomposes into five independently verifiable slices:

1. **Durable task sandbox:** wire Postgres into the normal runtime, fix nested attenuation and allowance-growth defects, and persist idempotent financial actions.
2. **Real task funding:** one verified principal funds and recovers one isolated task balance.
3. **Agent card:** provider-hosted principal onboarding, task-card issuance, authorization webhooks, freeze, revoke, and reconciliation.
4. **Principal delegation flow:** contract approval, agent start, live spend, evidence, decision, status, and receipt.
5. **Recovery:** refunds, reversals, disputes, delayed events, and scheduled reconciliation.

Each slice requires its own implementation plan and verification gate. The first slice must complete before any public real-money endpoint is exposed.

## 14. Main tradeoff

The design chooses an opinionated, temporary agent-task environment instead of a general wallet API. This makes Scrip narrower than Natural and less configurable than building directly on financial primitives, but gives developers a complete delegation lifecycle in one abstraction.

The rejected alternative is to expose wallets, cards, transfers, and policy objects independently. That would reproduce the provider layer and force every developer to rebuild the task semantics Scrip is intended to supply.

## 15. Success criteria

The design succeeds when a human or developer can fund one agent task without implementing wallet lifecycle, card controls, cross-tool accounting, or reconciliation, while Scrip can prove:

- The principal saw and approved the financial terms.
- The agent and every descendant never received more authority than its parent allowed.
- Card, inference, API, and compute spend remained under one root task budget.
- Unused confirmed funds returned to the principal.
- Every external financial fact appears in one reconciled receipt.
