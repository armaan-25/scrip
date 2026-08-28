# Human Task Financial Sandbox

**Date:** August 28, 2026  
**Status:** Proposed design  
**Product:** Scrip  
**Assumption:** The temporary expense card is issued to the hired human, not to the agent or a labor marketplace.

## 1. Summary

Scrip lets a developer create a temporary, real-money financial environment for one task that an agent delegates to a human. The environment holds the task's funds, reserves the worker's compensation, issues the worker a constrained expense card, records every authorization and transfer, and closes when the task settles.

The developer-facing promise is:

> Create a funded job with one API call. Scrip pays the worker, gives them a task-scoped expense card, and returns unused money when the job closes.

Scrip does not become a bank, card issuer, payroll provider, contractor marketplace, or general-purpose agent wallet. Regulated providers own custody, identity verification, card issuance, and money movement. Scrip owns the task contract and its lifecycle across those primitives.

## 2. Product boundary

### Scrip owns

- The task identity and lifecycle.
- The allocation of a total task budget into compensation, expenses, and contingency.
- Attenuated authority when an agent delegates work.
- Reservations before financial actions.
- The relationship between a worker, their task, and their temporary expense credential.
- Evidence submission and acceptance state.
- Settlement orchestration, unused-fund return, and one task receipt.
- Reconciliation of provider events into the task ledger.

### Financial providers own

- Custody of real funds.
- KYC, KYB, sanctions screening, and required tax or cardholder information.
- Bank transfers and payout delivery.
- Card issuance, tokenization, authorization, clearing, refunds, and disputes.
- PCI-scoped handling of card credentials.
- Legally required account statements and financial disclosures.

### Scrip does not own in the first release

- Worker discovery or matching.
- Employment classification or payroll.
- Pricing or negotiation between the agent and worker.
- Automated adjudication of subjective work.
- Lending, credit, insurance, or guaranteed refunds.
- International payouts or multi-currency tasks.
- Anonymous workers.
- A general consumer wallet.

### Provider strategy

The intended funding and worker-payout adapter is Natural because its currently published products include programmable wallets and direct payments to agents, businesses, and consumers. Scrip uses Natural as a financial rail; it does not reproduce Natural's custody, identity, compliance, or transfer APIs.

The worker-card adapter cannot assume Natural card issuance in the first release because Natural currently marks Cards as `Soon`. The existing Ramp Agent Card integration also does not prove that a card may be issued to and used by an invited human contractor. Before the worker-card slice begins, a provider contract test must establish all of the following with the selected issuer:

- The provider permits Scrip's task-expense use case.
- The invited worker can become the legally recognized cardholder through a provider-hosted flow.
- Cards support programmatic spend limits, merchant or category restrictions, expiration, freeze, and revocation.
- Authorization, capture, reversal, refund, and dispute events are queryable and delivered through signed webhooks.
- Scrip can fund the card without holding raw card credentials or operating an undisclosed stored-value balance.

Until one issuer passes that gate, the worker-card slice is `PARTIAL` and must not be represented as live. Natural's current authorized-use policy also prohibits building a product that competes with Natural using Natural's technology, so a Natural-backed release requires written confirmation that Scrip's task-sandbox layer is an approved complementary use.

Current product references:

- [Natural Wallets](https://www.natural.com/wallet)
- [Natural Pay](https://www.natural.com/pay)
- [Natural Cards](https://www.natural.com/cards)
- [Natural Authorized Use Policy](https://www.natural.com/aup)

## 3. First user and first job

The first customer is a developer building an agent that occasionally needs a known human to complete a real-world task. The developer already knows whom to invite; Scrip is not responsible for sourcing the worker.

The first verified flow uses one task owner and one invited, identity-verified U.S. worker:

```text
Developer creates task with $100
-> $60 reserved for worker compensation
-> $30 assigned to worker expenses
-> $10 retained as contingency
-> worker accepts task and completes provider onboarding
-> provider issues a temporary $30 expense card
-> worker spends $21.40 and uploads evidence
-> task owner accepts the result
-> worker receives $60
-> pending card authorizations resolve
-> $18.60 returns to the task owner
-> card and task credentials are revoked
```

The initial live test should use a trusted worker, a small compensation amount, a low expense limit, and an ordinary permitted merchant. It is a production-rail verification, not a public labor marketplace launch.

## 4. Developer experience

The primary interface is an SDK. A hosted worker page handles invitation, disclosures, identity-provider handoff, card access, receipts, and submission.

```ts
const task = await scrip.tasks.create({
  title: "Photograph the new office signage",
  instructions: "Capture the entrance and all installed signs.",
  compensation: { amount: 60, currency: "USD" },
  expenses: {
    limit: 30,
    allowedCategories: ["local_transportation", "office_supplies"],
  },
  contingency: { amount: 10, currency: "USD" },
  expiresAt: "2026-08-30T17:00:00-04:00",
  acceptance: { mode: "owner_review" },
});

await task.invite({ email: "worker@example.com" });
```

The response includes identifiers and hosted links, never raw card credentials:

```ts
{
  taskId: "task_...",
  status: "funding_required",
  fundingUrl: "https://scrip.example/tasks/task_.../fund",
  ownerUrl: "https://scrip.example/tasks/task_...",
}
```

The owner can subscribe to webhooks for task state changes, worker submissions, card activity, payout completion, refunds, disputes, and reconciliation failures.

## 5. Core domain model

### `TaskContract`

The durable statement of the job and its financial bounds:

- Owner identity.
- Worker invitation and verified worker identity reference.
- Instructions and expiry.
- Compensation allocation.
- Expense allocation and merchant/category restrictions.
- Contingency allocation.
- Acceptance policy.
- Cancellation and recovery policy.

Terms become immutable after the worker accepts. A material change creates a new version that the worker must accept before work continues.

### `TaskSandbox`

The live financial environment associated with one accepted contract:

- Provider account or wallet reference.
- Funding state.
- Compensation reservation.
- Expense-card reference and status.
- Contingency balance.
- Active provider credentials and their expiry.
- Current lifecycle status.

### `TaskParty`

An authenticated participant with one role:

- `owner`: funds the task, accepts or rejects submitted work, and receives returned funds.
- `worker`: accepts the contract, uses the expense card, submits evidence, and receives compensation.
- `agent`: acts for the owner through explicitly scoped credentials but cannot approve its own outcome.

### `FinancialAction`

An idempotent reserve/commit/cancel record for:

- Task funding.
- Worker payout.
- Card authorization and capture.
- Card reversal or refund.
- Task sweep.
- Provider fee.

Each action stores the provider, provider object ID, idempotency key, requested amount, committed amount, status, timestamps, and related task allocation.

### `TaskReceipt`

The final artifact contains:

- Original contract and accepted version.
- Total funded amount.
- Worker compensation paid.
- Expense authorizations, captures, reversals, and refunds.
- Provider fees.
- Amount returned to the owner.
- Submitted evidence and acceptance record.
- Provider transaction references.
- Any unresolved or disputed actions.

## 6. Lifecycle

The task state machine is:

```text
draft
-> funding_required
-> funded
-> worker_invited
-> worker_onboarding
-> active
-> submitted
-> accepted | revision_requested | cancelled
-> closing
-> settled | recovery_pending | disputed
```

### Creation and funding

1. The developer creates a `TaskContract`.
2. Scrip validates that compensation, expenses, and contingency sum to the total required funding.
3. Scrip creates an isolated provider-side wallet or equivalent funding container.
4. The owner funds the complete task amount before a worker can accept.
5. A provider webhook confirms funds are available; client redirects alone are not trusted as financial evidence.

### Worker acceptance and card issuance

1. The worker opens the signed, single-use invitation link.
2. The worker reviews compensation, expense restrictions, deadline, acceptance process, and cancellation terms.
3. The financial provider completes required identity and cardholder onboarding outside Scrip's normal application logs.
4. The worker accepts the immutable task version.
5. Scrip asks the expense-card provider to issue a task-scoped credential capped by the expense allocation and contract expiry.
6. The worker accesses the credential through a provider-hosted wallet or secure reveal flow. Scrip does not return PAN or CVV through its API.

### Work and expense accounting

1. Card authorization events create pending expense actions.
2. A capture commits the actual amount.
3. A reversal cancels the pending amount.
4. A refund creates a new recovery action; it does not mutate or erase the original capture.
5. Expense availability is reduced by both pending and committed transactions so concurrent authorizations cannot exceed the task allocation.
6. Receipts can be uploaded by the worker and attached to the corresponding authorization, but missing receipts do not alter the provider's financial truth.

### Submission and compensation

1. The worker submits evidence through the hosted task page.
2. The task enters `submitted`; the expense card is frozen for new purchases while existing authorizations can settle.
3. The owner accepts, requests revision, or cancels under the agreed contract.
4. The first release requires explicit owner acceptance before payout. An agent cannot approve work performed under its own delegated task.
5. Acceptance reserves and sends the compensation payout with a stable idempotency key.
6. Scrip treats provider confirmation or a reconciled provider query as authoritative; an ambiguous timeout remains `payment_pending`.

### Closure and recovery

1. Scrip revokes the expense credential.
2. It waits for, voids, or reconciles outstanding authorizations according to the provider's rules.
3. It sweeps unused expense and contingency funds back to the owner.
4. It records any refund that remains pending after closure as `recovery_pending` rather than overstating returned funds.
5. Once all required provider actions reach a terminal state, Scrip emits the final receipt and marks the task `settled`.

## 7. Accounting invariants

The existing Scrip reservation invariant remains authoritative for every allocation:

```text
available = allowance - spent - pending - delegated
```

The human-task sandbox adds these requirements:

1. `compensation + expenses + contingency = task funding requirement` at contract creation.
2. A worker payout cannot exceed the accepted compensation allocation.
3. Card pending plus card settled spend cannot exceed the expense allocation.
4. A child allocation cannot exceed its parent's available balance.
5. Provider events are append-only financial facts; refunds and reversals are separate actions.
6. A provider object ID and event ID can affect the ledger at most once.
7. A task cannot settle while a payout, sweep, or material card authorization is ambiguous.
8. The amount reported as returned must equal confirmed provider-side credits, not an internal calculation alone.
9. Revocation stops future authority but does not pretend to reverse already captured transactions.

## 8. Failure and recovery semantics

### Worker declines or never onboards

The task expires, no card is issued, no compensation is paid, and all confirmed funds return to the owner minus disclosed non-refundable provider fees.

### Owner cancels before work begins

The card is revoked and funds return after pending authorizations resolve. No worker compensation is paid unless the accepted contract defines a cancellation fee.

### Worker submits unacceptable work

The owner may request revision or cancel according to the accepted contract. The first release does not let Scrip or an LLM unilaterally adjudicate subjective quality.

### Payment request times out

Scrip persists `payment_pending` before contacting the provider, then queries by idempotency key or provider reference. It never retries an ambiguous real-money operation blindly.

### Captured card purchase needs recovery

Scrip may orchestrate a merchant refund or card dispute when legitimate and supported. It does not promise arbitrary clawback. A captured, non-refundable purchase remains spent.

### Provider webhook is delayed or duplicated

Signed webhooks are deduplicated by provider event ID. A scheduled reconciliation process compares every non-terminal action with provider state and repairs missed local transitions.

### Scrip process crashes

All money-related state must be durable before external I/O. Restarted workers resume from persisted actions and reconcile provider state rather than reconstructing state from memory.

## 9. Architecture and ownership

The behavior executes in three runtimes:

```text
Developer backend
-> calls Scrip SDK/API and receives webhooks

Scrip service
-> owns task contracts, ledger, policy, orchestration, and reconciliation

Financial providers
-> own custody, identity verification, card issuance, transfers, and network events
```

The implementation should extend existing boundaries rather than insert real-money logic directly into transports:

- `src/lease.ts`: preserve task, delegation, and reservation invariants until the existing domain split is completed.
- `src/store.ts` and `src/infrastructure/postgres/`: durable task, action, receipt, and idempotency records. Real-money mode must not use the in-memory store.
- `src/runtime.ts`: compose providers, stores, handlers, and reconciliation.
- `src/payment-executor.ts`: evolve from a mock-only experiment into an explicit payout-provider boundary; do not hide card issuance inside it.
- New `ExpenseCardProvider`: issue, freeze, revoke, and query worker task cards.
- New `WorkerPayoutProvider`: create and reconcile compensation transfers.
- New `TaskFundsProvider`: create and sweep task funding containers.
- Transport handlers: expose task operations without containing accounting policy.
- Hosted worker interface: render the accepted contract and provider-hosted onboarding/card flows; it never stores raw financial credentials.

Provider capabilities may come from one vendor or several. Scrip's domain consumes capability-specific interfaces so replacing a card issuer does not change task settlement logic.

## 10. Security, compliance, and authority

- Real-money mode requires the transactional Postgres store to be wired into normal runtime paths.
- Every mutating request requires an authenticated principal and a task-scoped authorization check.
- Owner, worker, and agent credentials are separate and revocable.
- Invitation tokens are single-use, hashed at rest, and expire.
- Webhook signatures are verified against raw request bodies.
- Monetary amounts use integer minor units and an explicit currency.
- The system never logs or stores PAN, CVV, full government identifiers, or provider secrets.
- Provider secrets live in a secret manager and are rotated independently.
- The worker must review provider and task disclosures before card issuance.
- The first release is U.S.-only and restricted to provider-supported workers and permitted merchant categories.
- Public launch is blocked until counsel and providers confirm cardholder, contractor, tax-reporting, money-transmission, and dispute responsibilities.

## 11. API surface for the first release

The first release needs only these operations:

```text
POST /v1/tasks
POST /v1/tasks/:id/fund
POST /v1/tasks/:id/invitations
POST /v1/tasks/:id/accept
POST /v1/tasks/:id/submissions
POST /v1/tasks/:id/accept-outcome
POST /v1/tasks/:id/request-revision
POST /v1/tasks/:id/cancel
GET  /v1/tasks/:id
GET  /v1/tasks/:id/receipt
POST /v1/provider-webhooks/:provider
```

Card reveal, KYC, bank details, and sensitive identity collection remain provider-hosted. Scrip endpoints return hosted links and status only.

## 12. Verification strategy

### Domain tests

- Allocation totals and integer-money arithmetic.
- Concurrent card authorizations cannot exceed the expense allocation.
- Worker compensation cannot be paid twice.
- Child allocations remain attenuated after nested settlement.
- Revocation stops future actions without rewriting committed spend.
- Refunds and reversals remain append-only actions.

### Persistence and concurrency tests

- Postgres row locking prevents cross-process overspend.
- Provider event and request idempotency survive retries and restarts.
- A crash after provider success but before local completion is repaired by reconciliation.
- Duplicate and out-of-order webhooks converge on the same ledger state.

### Provider contract tests

- Funding, card issuance, freeze, revoke, payout, sweep, refund, and query adapters against provider sandboxes.
- Raw webhook signature verification using provider fixtures.
- Explicit capability failure when an adapter cannot issue a card to the worker's legal identity.

### Live verification

A feature is not called real-money complete until one bounded task demonstrates, on production financial rails:

1. Confirmed owner funding.
2. Worker identity/provider onboarding.
3. Worker task-card issuance.
4. One permitted merchant authorization and capture.
5. Evidence submission and explicit owner acceptance.
6. Worker compensation received.
7. Card revocation.
8. Unused funds confirmed returned.
9. Final receipt reconciled against every provider object.

If any provider capability is unavailable, the result is `PARTIAL`; the demo must not substitute a mock while claiming the end-to-end flow passed.

## 13. Delivery sequence

The product is too broad to implement as one change. It decomposes into five independently verifiable slices:

1. **Durable task sandbox:** wire Postgres into the normal runtime, fix nested attenuation and allowance-growth defects, and persist idempotent financial actions.
2. **Real task funding and payout:** one owner funds a task and one verified worker receives compensation after explicit acceptance.
3. **Worker expense card:** provider-hosted onboarding, issuance, authorization webhooks, freeze, revoke, and reconciliation.
4. **Hosted worker and owner flow:** invitation, contract acceptance, evidence submission, decision, status, and receipt.
5. **Recovery:** refunds, reversals, disputes, delayed events, and scheduled reconciliation.

Each slice requires its own implementation plan and verification gate. The first slice must complete before any public real-money endpoint is exposed.

## 14. Main tradeoff

The design chooses an opinionated, temporary job environment instead of a general wallet API. This makes Scrip narrower than Natural and less configurable than building directly on financial primitives, but gives developers a complete lifecycle in one abstraction.

The rejected alternative is to expose wallets, cards, transfers, and policy objects independently. That would reproduce the provider layer and force every developer to rebuild the task semantics Scrip is intended to supply.

## 15. Success criteria

The design succeeds when a developer can create one funded human task without implementing wallet lifecycle, card controls, payout state, or reconciliation, while Scrip can prove:

- The worker saw and accepted the financial terms.
- The worker never received more expense authority than the task allowed.
- Compensation was released exactly once after acceptance.
- Unused confirmed funds returned to the owner.
- Every external financial fact appears in one reconciled receipt.
