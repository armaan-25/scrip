# Scrip Personal Agentic Payments Wallet

**Status:** Full product specification; implementation staged below
**Product scope updated:** September 16, 2026
**Research reviewed:** September 10, 2026
**Supersedes:** `docs/superpowers/specs/2026-08-28-human-task-financial-sandbox-design.md` where that document excludes a consumer wallet
**Product sentence:** Scrip lets a person connect funding, create or connect a persistent personal agent, delegate financial authority for one or multiple purchases, verify the promised outcomes, and manage cancellation, refund, replacement, or dispute when a result fails. Authority remains bound to the approved agent configuration as its software changes.

## Authority of this specification and implementation status

This document defines the complete product, including the versioned identity and financial authority model developed in the white paper. Hotels are the first regression fixture and live integration candidate, not the product boundary. Full product requirements take precedence over older hotel-only language in the implementation brief and handoff. Requirements describe intended behavior, not evidence of delivery.

As audited September 16, the implemented mission slice supports one exact hotel purchase through fake payment and execution adapters, contract approval, durable reservations, evidence assessment, revocation, and refund accounting, plus persistent agent identity with version-bound mandates (see that section for scope and limits). The suite reports 247 passed and 8 skipped: 50 hotel mission cases and 21 agent-identity cases. It does not implement the full wallet, authenticated agent versions, multiple items, consumer UI, mission HTTP routes, workers, signed evidence ingestion, or live provider composition. The old `HANDOFF.md` count of 170 is historical.

## Full consumer journey

1. The consumer signs in and connects a card, bank account, or supported partner-held wallet through the provider's secure enrollment flow. Scrip displays the funding source, provider-reported balance when available, spendable authority, pending holds, and freshness separately.
2. The consumer creates an embedded personal agent or connects an external agent through a supported SDK, CLI, or MCP integration. The agent has a persistent name, owner, lineage, registered software version, and scoped runtime credential.
3. The consumer delegates a financial sandbox: funding source, aggregate budget, time window, permitted merchants/categories/actions, per-purchase ceiling, approval thresholds, recurring-payment rules, and recovery permissions.
4. The consumer describes a goal involving one or multiple products. Scrip turns it into a versioned mandate with typed constraints, item requirements, success conditions, and a policy for partial completion. Unresolved hard requirements block purchases.
5. The agent searches and proposes items. Exact-approval mode asks the consumer to approve a specific item or basket. Bounded-selection mode permits selections within explicitly approved requirements without prompting for every compliant purchase.
6. Scrip verifies the authenticated principal, agent version, mandate, policy, quote and funding status; reserves exposure atomically; then issues a scoped payment capability through a supported provider.
7. The agent executes checkout. Scrip tracks each payment and each item's fulfillment independently, including ambiguous operations and partial failures.
8. The consumer sees progress, approvals, agent changes, receipts, and recovery in one place. Pause controls stop future authority while outstanding payments remain visible and reconcilable.
9. Scrip verifies outcomes and operates permitted cancellation, refund, replacement, or rebooking workflows. Disputes require fresh confirmation of the exact statement. Posted funds and promises remain distinct.
10. Agent updates preserve history but trigger authority review according to the mandate's change policy. New authority is never inferred from an unchanged agent name.

Example: “Buy a monitor and keyboard for my home office, under $600 including delivery and tax, delivered by October 10. The monitor must have USB-C charging and both items must be returnable for 30 days. Ask before substituting a requirement.” Two merchants can produce two operations and receipts under one mission ceiling. A delivered keyboard and a failed monitor order produce partial completion with item-specific recovery; they never produce an unqualified success.

## Funding and payment capabilities

The wallet experience includes connected funding, provider-held balances where supported, scoped virtual cards or delegated tokens, transaction history, funding status, and freeze/revoke controls. Funds remain at the selected provider; Scrip maintains authority and reconciliation records. Linking a source does not transfer money. Funding or withdrawing a partner balance is a separately authorized operation.

Card, bank, stablecoin, and machine-payment adapters are part of the full architecture. Route choice considers merchant acceptance, amount, fees, timing, currency, reversibility, and provider capabilities. Start with one supported live rail; add additional rails without weakening the same authorization gate. If conversion is needed, obtain a quote and authorize the total cost, exchange rate tolerance, fees, destination, and quote expiry before execution. No silent switch of funding source or rail after approval.

Supported payment intents include purchases, metered API/tool payments, and explicitly authorized transfers to identified counterparties. Each has its own outcome type: order fulfillment, delivered API entitlement/result, or confirmed beneficiary credit. Generic “payment sent” is insufficient proof for a purchase. Incoming payments and refunds are reconciled as provider facts and do not grant new agent authority automatically. Credit, lending, investment activity, and issuing or custody operated by Scrip remain outside the product scope.

## Persistent agent identity and version-bound authority

**Implementation status (September 16, 2026): partial.** Implemented in
`src/missions/agent-identity.ts` and `src/missions/agent-registry.ts`,
integrated into `PurchaseMissionService.approve()/execute()/getReceipt()`,
covered by 21 tests in `tests/agent-identity.test.ts`. Verified with
`npm run build` (exit 0), `npx tsc --noEmit` (exit 0), `npm test` (exit 0,
247 passed / 8 skipped).

- `AgentLineage`, `AgentVersion`, `FinancialMandate` - **implemented** as
  `SqliteAgentRegistry` records.
- Canonical manifest + digest - **implemented** (`canonicalManifest()`,
  `manifestDigest()`; tamper detection via `verifyManifestIntegrity()`).
- Scoped runtime credentials, explicit registration/authentication boundary -
  **implemented** (`issueCredential()`, `authenticate()`, `rotateCredential()`;
  secrets hashed at rest, compared in constant time).
- Change table and fail-closed classification - **implemented**
  (`classifyManifestChange()`, `strictestTransition()`); a code or dependency
  change is always `unknown_effect` / `require_review`.
- Checks before reservation and immediately before dispatch, revocation racing
  an in-flight operation - **implemented** (`checkAuthority()` at both stages;
  post-dispatch operations reconcile under their original version).
- Receipts naming the acting version and its assurance level - **implemented**
  (`MissionReceipt.agentVersionId` / `agentAttestationLevel`).
- **Not implemented:** attestation beyond `self_declared`; payload-digest,
  audience, and expiry binding on individual agent *requests* (credential
  binding is at session level, not per-request); version-partitioned
  reputation; selective disclosure/redaction of manifest content; signed
  mandate artifacts (`signatureRef`); `principalSessionRef` — human
  authentication is still a caller-supplied `consumerId`.

Four distinct records are required:

- `AgentLineage`: stable identity, consumer owner, operator, creation date, status, and historical versions. A lineage ID carries history, not permission.
- `AgentVersion`: immutable canonical manifest, manifest digest, parent version, registration issuer, attestation level, model identifier, instruction/policy digests, code artifact, tool versions and permissions, and runtime credential bindings. Mutable model aliases must be marked as such; unobservable upstream changes are an explicit attestation limitation.
- `FinancialMandate`: principal, lineage, authorized version or approved version set, funding source, scopes, time window, policy version, budget, outcome-contract digest, approval evidence, revocation epoch, and change policy.
- `OutcomeReceipt`: exact mandate and agent version for each operation, decision, reservation, provider references, fulfillment evidence, recovery events, and reconciled amounts.

Contract versions describe what the person authorized; agent versions describe the software exercising that authority. They are different identifiers. Existing `OutcomeContract.version` does not implement agent versioning. An agent request must authenticate a scoped runtime key and bind mandate, version, operation ID, payload digest, audience, expiry, and replay protection. A self-declared version string or caller-supplied consumer ID is not identity verification.

The server issues or records a signed mandate following authenticated human approval. The signature proves the authorization record's issuer and integrity; it does not prove private reasoning or fulfillment. Reuse standard authorization and payment artifacts where applicable. Scrip's version registry is an application model, not a claimed universal legal KYA standard.

| Change | Default authority transition |
|---|---|
| Display or logging only, established by trusted release process | Record new version; retain permitted authority |
| Dependency or code change of unknown behavioral effect | Require review; no automatic exemption for a “patch” label |
| Model, system instructions, financial policy, or tool implementation change | Pause affected spending pending approval |
| New tool or expanded permission | Require explicit approval of the expanded scope |
| Operator or ownership change, compromised credential | Revoke affected authority |
| Planned key rotation | Authenticated rotation procedure; bind replacement credentials explicitly |
| Revoked-version rollback or replay | Reject regardless of signature validity |

Unclassified changes fail closed for new spending. Evaluate every active mandate when a version changes and check authorization again immediately before dispatch. Revocation cannot retract an already dispatched external operation; reconcile that operation under its original version. Trusted workload attestation may later strengthen the binding between manifest and running software. A manifest signature alone does not establish runtime integrity. TEE integration is a later assurance option, not a prerequisite or proof of correct agent behavior.

Reputation is partitioned by principal, lineage, and version, with evidence counts, task category, failure/recovery history, and uncertainty. New versions may inherit a documented prior, never unconditional authority. Changes in budgets or approval thresholds require an existing consumer-approved adaptation policy and remain below its ceiling. Identity histories and manifests use access controls, selective disclosure, and redaction of instruction content and secrets.

## Multi-item mandates and financial semantics

The full product supports single items, exact baskets, and bounded selection of multiple items. Each item has a stable `itemId`, typed requirements, quantity, category, maximum all-in cost, candidate revisions, selected quote, outcome status, and recovery policy. Every provider operation has a unique key scoped to principal, mission, contract version, item or explicit basket, action, and attempt. Retries reuse that key. A newly authorized attempt is permitted only after the prior attempt is authoritatively resolved.

Concurrent item reservations share one mission ceiling and the consumer's applicable account/agent ceilings. A basket checkout may cover several items; its operation includes explicit allocations for item prices, tax, shipping, and fees. Allocations must sum to the authoritative transaction total. Partial captures and credits are stored once and allocated to their items without counting the same shared transaction several times.

Use integer minor units plus currency in the target domain; define conversion boundaries for the existing dollar-denominated lease engine. Do not reinterpret existing `550` dollar fixtures as cents. Each mandate declares both a net-spend ceiling and a cumulative gross-charge ceiling. Refunds may restore net capacity only after posting and only when explicitly allowed by the mandate; refunds do not reset the gross-charge ceiling. Replacement purchases require remaining authority or new approval, even when a refund has been promised.

Mission completion policy is explicit: `all_required` or `allow_partial` with approved minimum requirements. Real purchases across merchants are not atomically reversible. A failed item stops dependent purchases and triggers the approved compensation policy; successful unrelated items are retained or returned according to that policy. A partial result remains labelled partial even if the consumer accepts it. An unpaid failed item needs no refund; recovery status must reflect zero financial exposure.

Standing mandates are supported for renewals, recurring procurement, and metered services, with per-period and lifetime ceilings, renewal dates, usage limits, expiry, and explicit merchant-initiated-payment permissions. They are never inferred from a one-time purchase. Metered usage reserves bounded exposure before consumption and halts or requests approval before its limit.

## Consumer surfaces and integration experience

The product includes a responsive consumer application with wallet/funding overview, agents and permissions, mission creation, exact-basket or bounded-mandate approval, item progress, an approval inbox, agent-change review, receipts, and recovery/support views. Users can pause a mission, an agent, or all new spending. Pending operations remain displayed until reconciled.

Show human-readable changes such as “This agent gained a purchasing tool; approve to resume” with scope and budget consequences. Do not require the consumer to understand manifest hashes. Funding balances, available authority, pending exposure, captured spend, unused authorization, and posted refunds must have separate labels. Notifications are driven by approvals, material changes, deadlines, failures, and posted recovery, not every tool call.

The embedded agent is the default experience. External agents can use the same authority and receipt APIs through an SDK, CLI, or MCP adapter. The external agent cannot override policy, self-register trusted attestation, approve its own request, or submit evidence as authoritative simply by labelling it merchant evidence.

## Full product acceptance and delivery stages

These are requirements for the full product, not features already shipped:

1. **Existing hotel baseline:** preserve its 50 expanded regression cases and separately reconcile documentation with actual code.
2. **Identity and authority:** authenticated consumers, persistent lineages, registered versions, scoped keys, signed approval records, revocation, change review, and tests for tampered manifests, key rotation, rollback and stale-authority dispatch.
3. **General missions:** typed hotel/ecommerce/subscription or service requirements; exact and bounded approval; multiple items, shared budgets, basket allocation, partial outcomes, item refunds, and replacement limits. Preserve hotel behavior through a domain adapter.
4. **Consumer wallet:** connected funding and provider-held balance display, embedded agent, mobile-friendly approvals, mission progress, receipts, support, and account recovery. A second-device approval must bind the same immutable terms.
5. **Reliable integrations:** selected execution/payment adapters, authenticated HTTP routes and signed webhooks, durable dispatch/reconciliation workers, operation lookup, retries with backoff, scheduling, incident telemetry, and provider contract tests. A crash between durable intent and dispatch must have an explicit recovery procedure; claim-plus-never-retry is insufficient for full-product availability.
6. **Live supported release:** one permitted funding and payment rail, constrained merchant coverage, real fulfillment verification and a real posted refund, with recorded user authorization for live activity. Mock evidence cannot satisfy this gate.
7. **Expanded capabilities:** additional rails, explicit transfers and machine payments, standing mandates, replacement/rebooking and confirmed disputes, version-aware reputation, and optional stronger runtime attestation.

Full-product acceptance must additionally demonstrate: two agents sharing one funding ceiling cannot overspend; two item purchases do not duplicate charges after restart; a partial basket refund updates only the affected allocations; version changes cannot preserve unauthorized capabilities; unknown evidence cannot self-certify success; pause during dispatch preserves outstanding exposure; posted refunds restore authority only under policy; recurring charges stop at expiry; and every receipt traces principal → lineage/version → mandate → item/operation → payment → outcome/recovery.

Full completion requires usable consumer flows and evidence from selected providers, not only a green library test suite. Implementation should progress in independently reviewable increments; updating this specification does not execute a live payment or authorize an entire implementation in one change.

## Problem

Consumer agents are gaining ways to pay, but payment authorization is not the same as task completion. A correctly authorized charge can still produce the wrong item, a broken reservation, a missed cancellation, or a refund that never posts. Existing wallets and payment infrastructure primarily prove who authorized a transaction and whether it settled; Scrip must remain responsible until the consumer's requested outcome is verified or the supported recovery path reaches a truthful terminal state.

The product must feel like one end-to-end wallet to the consumer even when regulated accounts, card issuance, browser execution, and merchant processing are supplied by partners.

## Product thesis

> Give your agent a goal and bounded financial authority. Track what it buys, verify what arrives, and recover when something goes wrong.

Scrip's durable product object is a `PurchaseMission`, not a card or an isolated transaction. Each mission contains an immutable `OutcomeContract` that connects:

- the consumer's natural-language goal;
- machine-checkable purchase constraints;
- the exact authority delegated to the wallet's agent;
- payment and merchant evidence;
- the success conditions the wallet must verify;
- the permitted recovery actions;
- the final financial and outcome state.

Scrip owns the complete mission lifecycle. Partners may hold the funds, issue the credential, or run the browser, but Scrip decides when the mission is complete and explains why.

## First user and first job

The first user is a U.S. consumer who is willing to delegate a bounded online purchase but wants to retain final control over the purchase terms and any high-consequence recovery action.

The first product flow is:

```text
Consumer: "Book a refundable hotel in Boston for September 18–20,
under $550 total, rated at least 4 stars, with free cancellation
through September 16."

Scrip converts the request into an OutcomeContract
-> consumer reviews the exact hard constraints and $550 maximum
-> the embedded agent searches and prepares the exact purchase
-> consumer approves the exact purchase and mission
-> Scrip rechecks price, dates, cancellation terms, and merchant
-> Scrip durably reserves exposure and creates a scoped payment capability
-> the agent completes checkout through a supported execution provider
-> Scrip records the authorization, order, and cancellation policy
-> Scrip monitors the reservation and any requested cancellation
-> the mission closes only after the reservation is verified or recovery reaches a truthful terminal state
```

Hotel booking is the reference implementation because the mission has explicit dates, price, cancellation terms, confirmation evidence, and a plausible refund path. The domain model must remain generic enough for subscriptions and ordinary e-commerce, but those categories are not required for the first production verification.

## Market need

The evidence supports a bounded, reversible wallet rather than unattended general shopping:

- Visa's 2025 survey of 3,700 consumers in the U.S., Australia, and New Zealand reports that the main concerns about AI shopping agents are data security (50%), privacy (44%), purchase accuracy (42%), reliability (40%), and control (36%). It also reports a 64% average substitution rate for post-purchase tasks such as tracking, returns, and warranty registration. These are stated preferences after a demonstrated scenario, not observed autonomous purchase behavior.
- Checkout.com's 2026 research reports that consumers' leading requirements include spending caps (30%), instant revocation (29%), and easy cancellation (28%). The reported average amount consumers would delegate without another approval was £177, and willingness was strongest for low-risk repeatable categories. This is company-sponsored survey evidence and must not be treated as proven willingness to pay for Scrip.
- Gartner reports that willingness to let AI make purchase decisions topped out at 11% in the categories it tested. Among recent AI-shopping users, 54% said they had to double-check all AI-provided information and 62% said the information wasted their time. The product must therefore remove verification work rather than transfer it to the consumer.
- The U.K. Competition and Markets Authority describes current consumer-facing authority as bounded, with human escalation common and end-to-end autonomous decision-making still limited. This supports progressive autonomy and explicit responsibility boundaries.

The unresolved market question is not whether consumers value control. It is whether enough consumers will repeatedly delegate real purchases to a new wallet and whether recovery can be delivered with acceptable operational cost.

## Competitive landscape

### Kernel

Kernel provides the execution environment: isolated cloud browsers, managed authentication, persistent sessions, live view, replay, telemetry, and hosted agent runtimes. Its payment vault operates at browser egress and integrates initially with Stripe Link and Agentcard. Kernel can keep raw card data outside the agent and substitute or execute an authorized credential during an ordinary website checkout.

Kernel does not own the consumer's stored financial relationship, define the final outcome, or remain responsible for post-purchase recovery. Scrip should integrate with Kernel through an `ExecutionProvider`; it must not build competing browser infrastructure.

### Natural

Natural provides agent-native financial infrastructure: consumer and business wallets, transfers, agent identity and permissions, observability, and managed dispute tooling. Its current public pricing explicitly includes consumer accounts, so “Natural for consumers” is not a defensible distinction.

The distinction is the unit of responsibility:

- Natural's public product is organized around accounts, agents, transactions, tool calls, and disputes.
- Scrip is organized around a consumer mission whose success conditions extend across search, purchase, fulfillment, cancellation, and refund.
- Natural can establish that an authenticated agent was allowed to transact and provide ledger evidence.
- Scrip must establish whether the consumer's requested result occurred and automatically operate the permitted recovery workflow when it did not.

Natural's Authorized Use Policy, updated August 31, 2026, prohibits using its services to build a product that competes with Natural or its technology. Scrip must not use Natural as a production rail without explicit written authorization confirming the product is permitted.

### Link, Agentcard, Allowance, and Nekuda

- Stripe Link now gives consumer agents one-time cards or Shared Payment Tokens backed by a consumer's existing wallet, with per-request review and merchant/amount/currency scope. Stripe reports more than 200 million Link consumers.
- Agentcard provides an embeddable wallet, user approval, merchant- and amount-bound cards, and a purchase API.
- Allowance provides a consumer spend-control layer with iPhone approvals, one-time credentials, merchant restrictions, amount limits, and expiration.
- Nekuda provides credential collection, mandates, network tokens, and just-in-time card use for agent checkouts.

These products make “safe cards for agents” a feature category rather than Scrip's company-level wedge. Public materials reviewed for this spec did not establish a cross-agent consumer product that independently verifies arbitrary real-world outcomes and remains responsible through recovery. Absence from public materials is not proof that no private capability exists.

### Natural, Locus, Skyfire, Payman, AgentWallet, and on-chain wallets

This group competes on agent financial identity, balances, payment rails, cards, spend policies, API access, and audit history. Some also advertise escrow, communications identities, or refund use cases. Their breadth increases the risk of competing on infrastructure checklists. Scrip must not try to win on number of rails, currencies, card networks, or wallet-creation speed.

### Networks and protocols

Visa Intelligent Commerce, Mastercard Agent Pay and Verifiable Intent, Google AP2/UCP, OpenAI/Stripe ACP, and Stripe Shared Payment Tokens are standardizing identity, consent, mandates, token scope, merchant acceptance, and audit trails. Scrip should preserve these artifacts as evidence inside the `OutcomeContract`, not invent a proprietary replacement.

### Recovery products

Rocket Money and narrower cancellation, refund, and consumer-advocacy products validate demand for post-purchase work. They generally begin after a consumer already has a problem. Scrip's difference is that the same wallet records the original intent before payment, which gives the recovery agent stronger evidence and lets it prevent invalid purchases before they happen.

## Positioning

Do not position Scrip as:

- a generic agent card;
- a bank account for an agent;
- a browser automation platform;
- “Natural, but consumer”;
- a guaranteed-refund service;
- a chargeback bot;
- a crypto or stablecoin wallet;
- an expense-management product.

Position Scrip as:

> The outcome-native wallet for consumer agents. Scrip gives an agent bounded money for one mission, verifies what the consumer actually received, and stays on the problem through recovery.

The short consumer promise is:

> Tell your wallet what you want. It pays only within your rules and does not call the job finished until the result—or the recovery—is confirmed.

## Exclusions and first live release limits

- Owning custody, becoming a bank, or directly issuing cards.
- Building a browser, CAPTCHA network, residential proxy network, or credential vault.
- Supporting arbitrary merchants in the first live release.
- Cryptocurrency trading, securities, lending, credit underwriting, or investment activity.
- International and multi-currency consumer accounts in the first release.
- Automatically filing a card-network dispute or making a legal attestation without explicit consumer confirmation.
- Promising that captured payments can always be reversed.
- Universal escrow or “pay only after the final outcome.” Ordinary card authorization windows are shorter than many travel and fulfillment timelines.
- Letting the purchasing agent decide that its own work succeeded without independent evidence.
- A marketplace that ranks or recommends products for affiliate revenue.
- Selling infrastructure to enterprises in the first release.
- Rewriting the existing lease engine, reservation invariant, or provider adapters as part of the first mission-layer implementation.

## Core domain model

### `PurchaseMission`

The aggregate root for one consumer goal:

```ts
type PurchaseMissionStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'authorized'
  | 'executing'
  | 'purchased'
  | 'outcome_pending'
  | 'succeeded'
  | 'recovery_required'
  | 'recovering'
  | 'refunded'
  | 'partially_recovered'
  | 'disputed'
  | 'unrecoverable'
  | 'cancelled'
  | 'expired';

interface PurchaseMission {
  missionId: string;
  consumerId: string;
  status: PurchaseMissionStatus;
  contract: OutcomeContract;
  authorizationId?: string;
  executionRef?: string;
  createdAt: string;
  updatedAt: string;
}
```

### `OutcomeContract`

The consumer-approved, versioned mandate:

```ts
interface OutcomeContract {
  version: number;
  goal: string;
  category: 'travel' | 'subscription' | 'ecommerce' | 'service' | 'transfer' | 'mixed';
  currency: 'USD';
  maximumTotal: number;
  hardConstraints: OutcomeConstraint[];
  preferences: OutcomeConstraint[];
  permittedMerchants?: string[];
  expiresAt: string;
  approvalPolicy: 'confirm_exact_purchase' | 'confirm_exact_basket' | 'bounded_selection';
  agentLineageId: string;
  authorizedAgentVersionId: string;
  financialMandateId: string;
  fundingSourceId: string;
  items: PurchaseItem[];
  completionPolicy: 'all_required' | 'allow_partial';
  maximumGrossCharges: number;
  recyclePostedRefunds: boolean;
  successConditions: SuccessCondition[];
  recoveryPolicy: RecoveryPolicy;
  approvedAt?: string;
  approvalEvidence?: MandateEvidence;
}
```

`hardConstraints` are machine-testable predicates. Approved exact items/baskets and bounded-selection requirements are immutable. Amending them requires a new contract version and approval. Selecting a compliant candidate within approved bounded requirements does not require an amendment. The existing `purchase: HotelBooking` is a legacy implementation shape; it does not implement `items`.

`PurchaseItem` contains stable item ID, supported category, quantity, typed requirements, all-in ceiling, candidate/quote revisions, dependencies, success conditions and recovery policy. Category adapters own validation and fulfillment evidence. Full contracts additionally support service, transfer and mixed categories. Target money fields use integer minor units and currency; migrate existing dollar-denominated contracts explicitly using schema versions.

### `OutcomeConstraint`

```ts
type OutcomeConstraint =
  | { type: 'amount_at_most'; amount: number }
  | { type: 'merchant_in'; merchants: string[] }
  | { type: 'date_range'; startsOn: string; endsOn: string }
  | { type: 'refundable_until'; timestamp: string }
  | { type: 'rating_at_least'; value: number; scale: 5 }
  | { type: 'text_match'; field: string; expected: string };
```

Unknown constraint types must block unattended execution. They may be shown to the consumer as preferences but cannot silently become payment-policy enforcement.

### `MandateEvidence`

Records exactly what the consumer approved:

```ts
interface MandateEvidence {
  contractVersion: number;
  renderedSummaryHash: string;
  approvedBy: string;
  approvedAt: string;
  channel: 'web' | 'mobile';
  networkMandateRef?: string;
  principalSessionRef: string;
  agentVersionId: string;
  financialMandateId: string;
  signatureRef: string;
}
```

### `MissionEvent`

All financial, execution, evidence, and recovery events are append-only:

```ts
type MissionEventType =
  | 'contract_created'
  | 'contract_revised'
  | 'consumer_approved'
  | 'credential_issued'
  | 'execution_started'
  | 'purchase_authorized'
  | 'purchase_captured'
  | 'purchase_reversed'
  | 'merchant_confirmed'
  | 'outcome_verified'
  | 'outcome_failed'
  | 'recovery_requested'
  | 'merchant_refund_requested'
  | 'refund_pending'
  | 'refund_posted'
  | 'dispute_approval_requested'
  | 'dispute_submitted'
  | 'mission_closed';

interface MissionEvent {
  eventId: string;
  missionId: string;
  type: MissionEventType;
  occurredAt: string;
  source: 'scrip' | 'consumer' | 'execution_provider' | 'payment_provider' | 'merchant';
  externalId?: string;
  data: Record<string, unknown>;
}
```

Refunds, reversals, and disputes never overwrite the original capture. The current mission state is a projection of the append-only events.

### `RecoveryPolicy`

```ts
interface RecoveryPolicy {
  allowMerchantCancellation: boolean;
  allowMerchantRefundRequest: boolean;
  allowReplacement: boolean;
  allowRebooking: boolean;
  disputeRequiresConfirmation: true;
  recoveryDeadline?: string;
}
```

### Existing Scrip mapping

- One approved `PurchaseMission` creates one existing root `TaskAuthorization`.
- `maximumTotal` maps to the root allowance.
- The mission agent receives a root lease bound to its authenticated lineage/version; subagents receive attenuated child leases with their own identity bindings. The existing literal root agent label is insufficient.
- Every paid action uses the existing `reserveAction` / `commitAction` / `cancelAction` lifecycle.
- A card or wallet payment uses the existing purchase reservation path through a new provider adapter.
- Mission evidence extends `OutcomeEvidence`; it does not replace existing receipts.
- The invariant `available = allowance - spent - pending - delegated` remains unchanged.
- `revokeTask()` remains the mechanism that stops the full execution tree.

## Interface

The implemented hotel service is currently tested in isolation. The full product requires authenticated mission routes and the consumer application. Framework selection remains an implementation choice.

### Application service

```ts
interface PurchaseMissionService {
  create(input: CreatePurchaseMissionInput): Promise<PurchaseMission>;
  revise(missionId: string, patch: ReviseOutcomeContractInput): Promise<PurchaseMission>;
  approve(missionId: string, approval: ConsumerApproval): Promise<PurchaseMission>;
  execute(missionId: string): Promise<PurchaseMission>;
  recordEvent(event: ProviderMissionEvent): Promise<void>;
  verify(missionId: string): Promise<OutcomeAssessment>;
  requestRecovery(missionId: string, request: RecoveryRequest): Promise<PurchaseMission>;
  confirmDispute(missionId: string, confirmation: ConsumerApproval): Promise<PurchaseMission>;
  cancel(missionId: string): Promise<PurchaseMission>;
  get(missionId: string): Promise<PurchaseMission>;
  getReceipt(missionId: string): Promise<MissionReceipt>;
}
```

The target `execute()` schedules eligible item or basket operations under an approved contract, each with a durable idempotency key. Existing code dispatches only one hotel operation and reconciles on retry. Additional APIs must cover funding enrollment/status/disconnection, agent and version registration, scoped credentials, mandate approval/revocation, item proposals/approvals, agent-change review, per-item recovery, and account-wide pause. Every operation binds authenticated principal, lineage/version, mandate and item identifiers. Provider ingestion requires signature validation and replay protection. Define concrete API schemas in each implementation stage.

### HTTP routes

| method | route | responsibility |
|---|---|---|
| `POST` | `/v1/missions` | Create a draft contract from typed input and the consumer's goal. |
| `GET` | `/v1/missions/:missionId` | Return the mission, current projection, and consumer-safe event summary. |
| `POST` | `/v1/missions/:missionId/revise` | Create a new contract version before approval or after a material change. |
| `POST` | `/v1/missions/:missionId/approve` | Record explicit approval of the rendered contract version. |
| `POST` | `/v1/missions/:missionId/execute` | Start or resume the wallet agent after approval. |
| `POST` | `/v1/missions/:missionId/verify` | Run deterministic outcome checks and append the result. |
| `POST` | `/v1/missions/:missionId/recovery` | Request an allowed cancellation, refund, replacement, or rebooking. |
| `POST` | `/v1/missions/:missionId/dispute/confirm` | Confirm a specific dispute statement before submission. |
| `POST` | `/v1/missions/:missionId/cancel` | Revoke future authority and begin reconciliation. |
| `GET` | `/v1/missions/:missionId/receipt` | Return the complete mandate-to-outcome receipt. |
| `POST` | `/v1/webhooks/payments/:provider` | Receive signed payment events. |
| `POST` | `/v1/webhooks/execution/:provider` | Receive signed execution events. |

Production routes require authenticated consumer identity, ownership checks on every mission, idempotency keys for mutating requests, and signed-provider webhook verification. The current HTTP server explicitly lacks a production auth gateway, so no mission route may be publicly deployed until that boundary exists.

### Consumer confirmation screen

Before `approve`, the consumer must see:

- the exact item/basket or the bounded-selection requirements and permitted latitude;
- total price including taxes and fees;
- merchant;
- hard constraints and any unmet preference;
- cancellation and refund terms;
- which actions can happen without another prompt;
- the mission expiry;
- a one-action revoke control.

The screen must not reduce the mandate to a generic “Allow up to $X” prompt.

### Provider boundaries

```ts
interface ExecutionProvider {
  start(request: ExecutionRequest): Promise<{ executionRef: string }>;
  resume(executionRef: string): Promise<void>;
  stop(executionRef: string): Promise<void>;
  getEvidence(executionRef: string): Promise<ExecutionEvidence[]>;
}

interface PaymentCapabilityProvider {
  issue(request: ScopedPaymentRequest): Promise<{ capabilityRef: string }>;
  revoke(capabilityRef: string): Promise<void>;
  getTransaction(externalId: string): Promise<PaymentFact>;
  requestMerchantRefund(request: MerchantRefundRequest): Promise<RecoveryFact>;
  submitDispute(request: ConfirmedDisputeRequest): Promise<RecoveryFact>;
}

interface MissionStore {
  create(mission: PurchaseMission): Promise<void>;
  get(missionId: string): Promise<PurchaseMission | undefined>;
  append(event: MissionEvent, expectedVersion: number): Promise<void>;
  events(missionId: string): Promise<MissionEvent[]>;
}
```

Kernel is the preferred first `ExecutionProvider` candidate because its browser, auth, observability, and payment-vault boundary already match the required separation. The payment provider remains an open selection and must pass the provider gate below.

## Provider gate

No production-money integration is approved until written terms and a sandbox test establish:

1. The provider permits a consumer-facing agentic wallet completing purchases on a consumer's behalf.
2. Scrip can bind a credential to one consumer, mission, merchant, amount, currency, and expiry.
3. Raw PAN, CVV, bank credentials, and MFA secrets never enter the model context, Scrip logs, or browser recording.
4. Authorization, capture, reversal, refund, and dispute events are available through signed webhooks or authoritative polling.
5. Idempotency is supported for issue, charge, refund, and dispute operations.
6. Scrip can revoke future authority without claiming that a prior capture was reversed.
7. Liability, customer support ownership, prohibited uses, and dispute attestations are contractually clear.
8. The provider does not prohibit Scrip's product as competitive use.

Until a provider passes all eight checks, demos use fake money or the provider's explicit sandbox and must be labeled accordingly.

## Behavior

1. **Given** a new consumer goal, **when** Scrip creates a mission, **then** it remains `draft` and has no spending authority.
2. **Given** natural-language requirements, **when** they affect payment eligibility, **then** Scrip must translate them into typed hard constraints or block unattended execution.
3. **Given** a contract summary, **when** the consumer approves it, **then** Scrip stores the exact contract version and rendered-summary hash before issuing authority.
4. **Given** an unapproved or superseded contract, **when** execution is requested, **then** no browser session or payment capability is created.
5. **Given** an approved mission, **when** Scrip issues authority, **then** the total allowance equals `maximumTotal` and all child authority remains attenuated by the existing lease invariant.
6. **Given** a candidate purchase, **when** it differs from an approved exact item/basket or violates bounded-selection constraints, **then** payment is blocked and the consumer receives a proposed revision.
7. **Given** a valid candidate purchase, **when** checkout starts, **then** the maximum amount is reserved before external merchant or payment I/O.
8. **Given** provider success, **when** the authoritative captured amount arrives, **then** Scrip commits that amount and releases unused reservation.
9. **Given** provider failure before capture, **when** the failure is unambiguous, **then** Scrip cancels the reservation and records the failure evidence.
10. **Given** an ambiguous timeout, **when** Scrip cannot determine whether payment occurred, **then** the mission enters `outcome_pending`, preserves the reservation, and reconciles by idempotency key before retrying.
11. **Given** a completed checkout, **when** Scrip records the purchase, **then** it stores merchant confirmation, item or booking details, price, terms, and external references as append-only events.
12. **Given** a claimed successful outcome, **when** independent merchant, email, payment, or execution evidence is unavailable, **then** the purchasing agent cannot mark the mission `succeeded` from its own narrative.
13. **Given** evidence that every required item and mission condition holds, **when** verification completes, **then** the mission becomes `succeeded`. Accepted partial results remain explicitly labelled partial. Receipts are available at every stage.
14. **Given** a failed success condition with an allowed recovery path, **when** Scrip detects the failure, **then** it enters `recovery_required` and may begin merchant cancellation or refund work permitted by the contract.
15. **Given** a proposed card-network dispute, **when** the consumer has not confirmed the exact dispute facts, **then** Scrip must not submit it.
16. **Given** a refund request, **when** the merchant acknowledges it but funds have not posted, **then** the mission remains `recovering` or `refund_pending`; it must not report the money as returned.
17. **Given** a posted refund, **when** the payment provider confirms it, **then** Scrip appends a separate refund event and updates recovered and net-spend totals without deleting the original capture.
18. **Given** revocation, **when** the consumer cancels a mission, **then** Scrip revokes the root task, every descendant lease, the execution session, and future payment authority, while preserving already captured facts.
19. **Given** duplicate provider events or client retries, **when** the same external event or idempotency key is observed, **then** it changes the ledger at most once.
20. **Given** a terminal mission, **when** the consumer opens its receipt, **then** the receipt distinguishes authorized, reserved, captured, reversed, refunded, unrecovered, and returned amounts.

## Failure modes

### Constraint extraction is uncertain

Keep the mission in `draft`, mark the unresolved language, and require the consumer to select or type a deterministic constraint. Do not silently downgrade it to a preference.

### Consumer changes the goal after approval

Create a new contract version and revoke unconsumed capabilities before new spending. Already dispatched operations continue reconciliation under their original terms and retain their exposure. A revision never permits replay. Existing code requires a separate mission after execution starts; safe remaining-item revisions are future work.

### Execution provider fails

Stop the session if possible, retain the execution reference and replay evidence, cancel only unambiguous unpaid reservations, and allow `execute()` to resume idempotently. Do not create another purchase while payment state is unknown.

### Payment provider fails or times out

Persist intent before provider I/O. Reconcile using the provider idempotency key and external references. Never blindly retry an ambiguous real-money operation.

### Merchant page or terms change

Re-extract the exact purchase details. If any hard constraint or displayed term changed, block checkout and request a revised consumer mandate.

### Outcome evidence conflicts

Keep each source as a separate event, mark the assessment `unknown`, freeze new spending, and request consumer review. Never resolve conflicting evidence by trusting the agent's prose.

### Merchant refuses recovery

Record the refusal and policy cited. Offer only contractually and legally supported next steps. If no supported path remains, close as `unrecoverable`; do not imply a guarantee.

### Refund is promised but not posted

Track the promised date and continue reconciliation. The receipt shows `refund_pending` until authoritative payment evidence confirms the credit.

### Process crashes

All intent, reservation, and provider-call records must be durable before external I/O. On restart, replay mission events, restore the projection, query non-terminal provider operations, and resume without duplicating payment.

### Concurrent workers race

Use the existing atomic reservation invariant for money and optimistic version checks for mission events. Exactly one write may advance an expected mission version.

### Credential or session is compromised

Revoke the complete task tree, payment capability, and execution session. Preserve evidence for consumer support and provider investigation.

## Files

This is the implementation ownership map. Mission modules exist as a hotel-only library; transport and production composition remain planned. Add dedicated identity/version, mandate, funding and category modules during their stages. Architecture documentation must describe actual implementation separately from this target scope.

| file | change |
|---|---|
| `SPEC.md` | Authoritative consumer outcome-wallet product and implementation contract. |
| `src/missions/types.ts` | Own `PurchaseMission`, `OutcomeContract`, constraints, recovery types, and events. |
| `src/missions/mission-store.ts` | Define append-only `MissionStore` and optimistic concurrency semantics. |
| `src/missions/purchase-mission-service.ts` | Coordinate contract approval, existing task authorization, execution, verification, and recovery. |
| `src/missions/outcome-assessor.ts` | Evaluate typed success conditions against independent evidence. |
| `src/integrations/execution/execution-provider.ts` | Define the Kernel-compatible execution boundary. |
| `src/integrations/payments/payment-capability-provider.ts` | Define scoped credential, payment fact, refund, and dispute operations. |
| `src/handlers.ts` | Add transport-independent mission handlers; retain existing task/action handlers. |
| `src/interfaces/http/server.ts` | Add the mission and provider-webhook routes after production authentication is designed. |
| `src/runtime.ts` | Compose mission store, mission service, execution provider, and payment provider. |
| `src/store.ts` | Extend receipt/evidence types only where the mission receipt shares existing economic facts. |
| `tests/purchase-mission-service.test.ts` | Test lifecycle, contract versioning, idempotency, revocation, and recovery behavior. |
| `tests/outcome-assessor.test.ts` | Test deterministic success and conflicting-evidence cases. |
| `tests/http-missions.test.ts` | Test route validation, ownership, status mappings, and webhook deduplication. |
| `ARCHITECTURE.md` | After implementation, document consumer, application, domain, provider, and persistence boundaries. |
| `LEARNING.md` | After implementation, explain event sourcing, idempotency, mandates, and outcome verification with actual symbols. |

The existing dirty changes in `src/lease.ts` and `tests/lease.test.ts` are not part of this specification-writing task and must be preserved.

## Verification

### Specification verification

- `git diff --check -- SPEC.md` must exit `0`.
- Every named existing symbol in the “Existing Scrip mapping” section must be confirmed with `rg` before implementation.
- Every competitive capability used to justify a product boundary must retain an official source URL below.

### Implementation verification

Run the repository gate that exists at implementation time. If `.claude/checks.sh` exists, run exactly:

```bash
./.claude/checks.sh
```

Otherwise run:

```bash
npx tsc --noEmit
npm test
npm run build
```

Required new test cases:

1. Draft missions cannot spend.
2. Approval is bound to the exact immutable contract version.
3. A changed hard constraint requires reapproval.
4. Concurrent reservations cannot exceed the mission maximum.
5. Duplicate execution requests cannot produce a second purchase.
6. Ambiguous payment timeout does not retry blindly.
7. The purchasing agent cannot self-certify success.
8. Conflicting evidence produces `unknown`, not success.
9. Refund-pending is distinct from refund-posted.
10. Refund events do not erase captures.
11. Disputes require exact consumer confirmation.
12. Revocation reaches every child lease, execution session, and payment capability.
13. Duplicate webhooks affect the ledger once.
14. The receipt reconciles authorized, captured, refunded, and returned amounts.

### First live verification

The first production-rail test uses one consenting team member, a low maximum amount, one supported refundable hotel flow, and no unattended dispute. Capture:

- the approved mandate;
- provider-issued scoped capability without exposing raw credentials;
- browser replay and merchant confirmation;
- authorization and capture webhooks;
- deterministic verification of dates, merchant, total, and cancellation terms;
- a real cancellation in the permitted window;
- merchant refund acknowledgment;
- the posted refund from the payment provider;
- the final mission receipt.

A sandbox test does not count as production-rail verification. A merchant's refund promise does not count as a posted refund.

## Pilot and success metrics

Before broad provider or UI work, run a 10–20-person concierge pilot with the wallet experience manually supported behind the scenes. Include hotel cancellation/refund, missing e-commerce refund, and subscription cancellation cases, but keep the first automated purchase flow to the supported hotel adapter.

Measure:

- contract-to-approved-mission conversion;
- percentage of approved missions reaching a verified terminal outcome;
- constraint-violation prevention rate;
- median human approval prompts per mission;
- median time from problem detection to recovery request;
- percentage of promised refunds that are verified as posted;
- dollars recovered and unrecovered;
- human operations minutes per mission;
- percentage requiring credentials, MFA, or a phone call;
- percentage of consumers starting a second mission within 30 days;
- provider and merchant failure rates by step.

The go-forward signal is repeat delegation plus verified consumer value exceeding the cost of human operations. Sign-ups, waitlist size, and total authorized dollars are not sufficient.

## Decisions taken

### Embedded agent with external integration

Chosen: Scrip supplies an embedded agent and permits explicitly connected external agents through the same mandate enforcement. Consumers own funding and delegated authority. External agents require authenticated version and credential bindings. Scrip owns outcome tracking and recovery coordination across both modes.

### Outcome contract over transaction policy

Chosen: make `PurchaseMission` and `OutcomeContract` the top-level objects.
Rejected: add more fields to an agent card or lease.
Cost: mission state and evidence require a new persistence layer instead of remaining inside `TaskAuthorizationManager`.

### Partner rails and browser execution

Chosen: use provider interfaces for card/payment capability and Kernel-compatible execution.
Rejected: build issuing, custody, browser infrastructure, or a credential vault.
Cost: provider availability and terms constrain the first supported markets and merchants.

### Explicit approval before the exact first purchase

Chosen: preserve exact approval for the first live hotel verification. The full product also requires exact-basket and bounded-selection approval, followed by explicit standing mandates in the expanded-capabilities stage. Consumers choose, tighten and revoke their authority mode.

### Event ledger over mutable status records

Chosen: append immutable mission facts and project current state.
Rejected: overwrite one mission row as events arrive.
Cost: projections and versioning add implementation complexity, but refunds, disputes, and duplicated webhooks remain auditable.

### Merchant recovery may be automatic; disputes may not

Chosen: the approved contract may permit merchant cancellation, refund, replacement, or rebooking; card-network disputes require a fresh consumer confirmation of exact facts.
Rejected: let the agent file unattended disputes.
Cost: the hardest recovery path retains a human step.

### Narrow live merchant coverage

Chosen: prove one refundable hotel workflow before arbitrary commerce.
Rejected: promise “buy anything anywhere” in the first release.
Cost: the initial product looks narrower, but produces a falsifiable reliability and refund test.

## Open questions

1. Which regulated payment provider permits this exact consumer product and passes all eight provider-gate checks?
2. Will Kernel permit Scrip to operate as a wallet/payment integration, and can its evidence APIs expose the checkout facts required for deterministic verification?
3. Which hotel or travel merchant offers stable enough terms and interfaces for the first supported adapter?
4. Does the first consumer fund a dedicated balance, link an existing card, or receive a task-scoped virtual card backed by a partner account?
5. What consumer authentication mechanism and account-recovery policy should protect approval and revocation?
6. What specific evidence is sufficient for each supported success condition, and which conflicts require human review?
7. Who supplies human operations during the concierge pilot, and what maximum minutes per mission makes the model viable?
8. What is the initial business model: subscription, recovered-value fee, interchange, or a combination? No choice should be made before pilot cost and repeat-use data exist.
9. What legal disclosures distinguish merchant refund requests, statutory rights, card disputes, and Scrip's non-guarantee?
10. Which merchant/category adapters follow the initial hotel and ecommerce fixtures? Multiple categories are in scope; sequencing depends on demand and provider evidence.

## Research sources

Primary and official sources reviewed for this specification:

- Kernel platform and documentation: https://www.kernel.sh/ and https://www.kernel.sh/docs
- Kernel agentic payments: https://www.kernel.sh/blog/agentic-payments
- Natural products, pricing, and policy: https://www.natural.com/, https://www.natural.com/pricing, https://www.natural.com/wallet, https://www.natural.com/identity, https://www.natural.com/observability, https://www.natural.com/disputes, https://www.natural.com/aup
- Stripe Link wallet and Issuing for agents: https://stripe.com/blog/giving-agents-the-ability-to-pay
- Agentcard: https://www.agentcard.sh/ and https://www.ycombinator.com/companies/agentcard
- Allowance: https://www.ycombinator.com/companies/allowance
- Nekuda wallet documentation: https://nekuda.mintlify.app/system-overview
- Locus security and payment controls: https://paywithlocus.com/security and https://docs.paywithlocus.com/
- Skyfire payment features: https://docs.skyfire.xyz/docs/features
- Visa consumer research: https://corporate.visa.com/en/products/intelligent-commerce/earning-trust-report.html
- Mastercard Verifiable Intent: https://www.mastercard.com/global/en/news-and-trends/stories/2026/verifiable-intent.html
- Google Agent Payments Protocol: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
- U.K. Competition and Markets Authority consumer-agent review: https://www.gov.uk/government/publications/agentic-ai-and-consumers/agentic-ai-and-consumers
- Gartner consumer shopping surveys: https://www.gartner.com/en/newsroom/press-releases/2026-05-27-gartner-survey-finds-consumers-want-ai-shopping-help-but-not-ai-purchase-decisions
- Checkout.com consumer and merchant research: https://www.checkout.com/newsroom/consumer-demand-for-ai-shopping-is-forming-fast-but-trust-for-agentic-commerce-is-still-catching-up

Public product pages establish declared capability and positioning, not reliability, volume, regulatory approval for Scrip's use case, or willingness to partner. Those claims must be reverified during provider selection.

---

# Card slice: intent-bound authorization for a card rail

Scoped 2026-09-19. This section is self-contained and executable in a fresh
session. It builds on the hotel mission slice (`src/missions/`) and the agent
registry as committed at `5c07c79`, and on the demo committed at `9a05375`.
Everything above this line is the product contract; nothing above changes.

## Problem

The existing slice gates a purchase on the agent's *proposal*: `execute()`
runs `preflight()` over the candidate the agent hands it, then issues an
abstract single-use capability. On a card rail the issuer sees a second,
independent event the proposal never covers: the network authorization
request, carrying merchant descriptor, MCC, amount, and (only when the
merchant's checkout supplies it) the cart. Natural's announced Cards product
will inherit MCC-and-limit controls, which bound category and amount; every
incident in the paper passed those. The slice adds the issuer-side gate that
a card product would run, in two tiers, and shows the difference between a
merchant that supplies cart context (Accept) and one that does not.

Half of this exists already: `src/ramp-agent-card.ts` defines `CardIssuer`
and `MockCardIssuer`, and `TaskAuthorizationManager.reserveCardPurchase()`
mints a card capped at the reservation. What does not exist anywhere is code
that *receives* an authorization request and decides. That is this slice.

## Domain boundary: what runs at the issuer

This slice is a pitch that Natural could run the gate. So the gate must be
written as issuer-side code, with issuer-side inputs only. The split:

| runs at Scrip (the operator's side) | runs at the issuer (Natural's side) |
|---|---|
| PROPOSE, RATIFY, `preflight()` on the agent's candidate | store the `CardBinding` created at issuance |
| decide to request a card; supply the binding fields | receive the network authorization; run `authorizeCard()` |
| hold the contract, the registry, the mission store | receive cart context from its own Accept merchant; run `authorizeCart()` |
| `assessOutcome()` over payment + fulfillment + dispute evidence | freeze on revoke; capture; refund; forward chargebacks |
| receipt matching (`matchReceipt`) for off-Accept merchants | nothing about receipts; an issuer never sees the email |

Hard rule, enforced by a test (Behavior 15): `src/cards/card-gate.ts` and
`src/cards/card-rail.ts` import nothing from `src/missions/` except the
`HotelBooking` type and the `canonical()` function. No `OutcomeContract`, no
`SqliteAgentRegistry`, no `SqliteMissionStore`, no `PurchaseMissionService`.
If the gate needs something it does not have, the answer is to put it on the
`CardBinding` at issuance, because that is the only channel an issuer has.

Two consequences worth stating. First, the gate cannot say *which* field of
the order was wrong; it can only say the digest differs. The explanation
comes from the assessor, on Scrip's side, which holds the contract. Second,
the cart tier exists only because Natural would own both the card and the
merchant's checkout. For any other issuer the cart column is empty, and the
demo's web-merchant scenario is what every card product in the market does
today.

## Out of scope

- Any real rail. No Natural, no Ramp, no network. Fake issuer, fake network,
  fake merchants only. Natural Cards has no published schema and the AUP
  forbids wiring Natural in as a rail.
- Generalizing `HotelBooking`. The hotel stays the only purchase category.
- HTTP routes and webhooks. Network and merchant events are in-process calls
  on the fake rail.
- Real receipt parsing. `ReceiptIngestion` accepts an already-typed receipt;
  the LLM/PDF step that would produce it is stubbed by the fixture.
- Changing `TaskAuthorizationManager` or `src/ramp-agent-card.ts`. The new
  module stands beside them; `reserveCardPurchase()` is not called.
- Persisting rail state. `FakeCardRail` is in-memory. A real issuer persists
  bindings; that is its job, not Scrip's.
- Agent-version pin on the card binding. Version authority is already
  enforced at `pre_reservation` and `pre_dispatch` by `checkAuthority()`;
  the binding carries the operation key, which the mission ties to a version.
- Standing mandates, repeat purchases, multi-item carts, partial capture.

## Interface

New module `src/cards/`. All money is a JS number in USD, as in
`src/missions/`. All timestamps are ISO strings.

```ts
// src/cards/types.ts

/** What the issuer holds for one single-use card. Enough to decide an
 *  authorization without the contract: the digest stands in for it. */
export interface CardBinding {
  cardRef: string;                 // opaque, rail-issued; doubles as capabilityRef
  last4: string;
  operationKey: string;            // PurchaseOperation.key
  /** sha256(canonical(contract.purchase)) - the exact HotelBooking, not the
   *  whole contract, because a merchant can only hash the order it sees. */
  purchaseDigest: string;
  merchantDescriptors: string[];   // network-visible names allowed to charge
  ceiling: number;                 // contract.maximumTotal
  exactTotal: number;              // contract.purchase.total
  currency: 'USD';
  notBefore: string;
  expiresAt: string;
  singleUse: true;
  status: 'active' | 'used' | 'frozen';
}

export interface CartContext {
  merchantId: string;
  orderRef: string;
  booking: HotelBooking;           // from src/missions/types.ts
  digest: string;                  // merchant-computed sha256(canonical(booking))
}

export interface CardAuthorizationRequest {
  authRef: string;
  cardRef: string;
  merchantDescriptor: string;
  mcc: string;
  amount: number;
  currency: 'USD';
  occurredAt: string;
  cart?: CartContext;              // present only from an Accept merchant
}

export type CardAuthorizationDecision =
  | { approved: true;  tier: 'auth' | 'cart'; authRef: string }
  | { approved: false; tier: 'auth' | 'cart'; authRef: string; reasons: string[] };

export interface DisputeReason { category: 'notReceived' | 'other'; networkCode: string; description: string }

export interface DisputeObservation {
  externalId: string; operationKey: string; authRef: string;
  amount: number; currency: 'USD'; reason: DisputeReason; occurredAt: string;
}

/** An already-typed receipt, as a parser would produce it. */
export interface TypedReceipt {
  receiptRef: string;
  merchantDescriptor: string;
  last4: string;
  amount: number;
  currency: 'USD';
  booking: HotelBooking;
  receivedAt: string;
}
```

```ts
// src/cards/card-gate.ts   (pure; no I/O, no clock other than `now`)

export function purchaseDigest(booking: HotelBooking): string;   // sha256(canonical(booking))

/** Auth tier. Never looks at the cart. */
export function authorizeCard(binding: CardBinding, request: CardAuthorizationRequest, now: Date): CardAuthorizationDecision;

/** Cart tier. Called by authorizeCard when request.cart is present; also
 *  exported for direct testing. Recomputes the cart digest from cart.booking
 *  so a merchant cannot send a matching digest over a different order. */
export function authorizeCart(binding: CardBinding, request: CardAuthorizationRequest & { cart: CartContext }, now: Date): CardAuthorizationDecision;
```

`authorizeCard` reasons, in evaluation order, all accumulated (never
short-circuited except on unknown card):

| check | reason string |
|---|---|
| `binding.status !== 'active'` | `Card is ${status}` |
| `now < notBefore` or `now >= expiresAt` | `Card window closed` |
| `request.currency !== binding.currency` | `Currency mismatch` |
| `!merchantDescriptors.includes(request.merchantDescriptor)` | `Merchant descriptor not permitted` |
| `request.amount > binding.ceiling` | `Amount exceeds ceiling` |
| cart present → delegate to `authorizeCart` | (see below) |

`authorizeCart` adds, after the auth-tier checks pass:

| check | reason string |
|---|---|
| `purchaseDigest(cart.booking) !== cart.digest` | `Cart digest does not match its contents` |
| `cart.digest !== binding.purchaseDigest` | `Cart does not match the approved purchase` |
| `request.amount !== binding.exactTotal` | `Amount differs from the approved total` |

Tier in the decision is `'cart'` when a cart was present, else `'auth'`.

```ts
// src/cards/card-rail.ts   (the fake issuer + network + two merchants)

export class FakeCardRail {
  issue(input: Omit<CardBinding, 'cardRef' | 'last4' | 'status'>): CardBinding;
  freeze(cardRef: string): void;
  /** Runs authorizeCard. On approve marks the card 'used' and records the auth. */
  authorize(request: Omit<CardAuthorizationRequest, 'authRef'>): CardAuthorizationDecision;
  capture(authRef: string): PaymentFact;                    // kind 'captured'
  refund(authRef: string, amount: number): PaymentFact;      // kind 'refunded', same transactionRef
  chargeback(authRef: string, reason: DisputeReason): DisputeObservation;
  facts(operationKey: string): PaymentFact[];                // declined auth => one 'unpaid' fact, amount 0
  disputes(operationKey: string): DisputeObservation[];
  binding(cardRef: string): CardBinding | undefined;
  bindingsByLast4(last4: string): CardBinding[];
}

/** Merchant on Accept: sends CartContext with the authorization and, on
 *  capture, emits BookingEvidence with source 'merchant'. */
export class FakeAcceptMerchant {
  constructor(rail: FakeCardRail, options: { merchantId: string; descriptor: string; mcc: string });
  checkout(cardRef: string, booking: HotelBooking): { decision: CardAuthorizationDecision; evidence?: BookingEvidence };
}

/** Merchant off Accept: authorizes without a cart and, on capture, emits a
 *  TypedReceipt (what a confirmation email would parse to). */
export class FakeWebMerchant {
  constructor(rail: FakeCardRail, options: { descriptor: string; mcc: string });
  checkout(cardRef: string, booking: HotelBooking): { decision: CardAuthorizationDecision; receipt?: TypedReceipt };
}
```

```ts
// src/cards/receipts.ts   (pure)

/** Matches a typed receipt to a binding by last4 + descriptor + amount.
 *  Returns BookingEvidence with source 'email', or undefined when no
 *  binding matches (caller logs and drops). */
export function matchReceipt(receipt: TypedReceipt, bindings: CardBinding[], verifiedAt: string): BookingEvidence | undefined;
```

```ts
// src/cards/card-payments.ts

/** Adapts FakeCardRail to the existing PaymentCapabilityProvider so
 *  PurchaseMissionService is unchanged. capabilityRef === cardRef. */
export class CardPaymentCapabilityProvider implements PaymentCapabilityProvider {
  constructor(rail: FakeCardRail, merchantDescriptors: (booking: HotelBooking) => string[]);
  issue(request): Promise<{ capabilityRef: string }>;       // builds the CardBinding from ExecutionRequest
  getFacts(operationKey): Promise<PaymentFact[]>;
  getDisputes(operationKey): Promise<DisputeObservation[]>;  // new optional provider method, see below
  revoke(operationKey): Promise<void>;                       // freeze
  requestRecovery(request): Promise<{ externalId: string }>; // records intent; the demo posts the refund explicitly
}
```

Minimal changes to `src/missions/` (the only ones):

```ts
// src/missions/types.ts
type EventBody = ... | { type: 'dispute_observed'; data: DisputeObservation };
interface PaymentCapabilityProvider { ...; getDisputes?(operationKey: string): Promise<DisputeObservation[]>; }

// src/missions/purchase-mission-service.ts
async recordDispute(consumerId, missionId, input: DisputeObservation): Promise<void>;  // validates operationKey, dedupes on externalId, appends
// reconcile(): if payments.getDisputes exists, fetch and recordDispute each.

// src/missions/outcome-assessor.ts
// assessOutcome(): disputes = events of type 'dispute_observed' with reason.category === 'notReceived'.
//   if disputes.length && good.length  -> { status: 'unknown', reasons: ['Cardholder dispute conflicts with merchant confirmation; consumer review required'] }
//   if disputes.length && !good.length -> { status: 'failure', reasons: ['Cardholder disputed non-receipt'] }
//   evaluated before the existing conflicting-evidence check.
```

New script in `package.json`: `"demo:cards": "tsx demo/cards.ts"`.

## Files

| file | change |
|---|---|
| `src/cards/types.ts` | New. `CardBinding`, `CartContext`, `CardAuthorizationRequest`, `CardAuthorizationDecision`, `DisputeReason`, `DisputeObservation`, `TypedReceipt`. |
| `src/cards/card-gate.ts` | New. Pure `purchaseDigest()`, `authorizeCard()`, `authorizeCart()`. Imports `canonical` from `src/missions/outcome-assessor.ts`. |
| `src/cards/card-rail.ts` | New. `FakeCardRail`, `FakeAcceptMerchant`, `FakeWebMerchant`. In-memory Maps. |
| `src/cards/receipts.ts` | New. Pure `matchReceipt()`. |
| `src/cards/card-payments.ts` | New. `CardPaymentCapabilityProvider`. |
| `src/missions/types.ts` | Add `dispute_observed` event body; add optional `getDisputes` to `PaymentCapabilityProvider`. |
| `src/missions/purchase-mission-service.ts` | Add `recordDispute()`; `reconcile()` fetches disputes when the provider exposes them. No other change. |
| `src/missions/outcome-assessor.ts` | `assessOutcome()` gains the two dispute branches above. `preflight()` untouched. |
| `demo/cards.ts` | New. Three scenarios (Behavior 10 to 12). Exports `runCardsDemo(log)`. |
| `tests/card-gate.test.ts` | New. Pure gate cases (Behavior 1 to 6). |
| `tests/card-rail.test.ts` | New. Issue, authorize, single-use, freeze, capture, refund, chargeback, receipt matching (Behavior 7 to 9). |
| `tests/demo-cards.test.ts` | New. Runs `runCardsDemo(() => {})` and asserts the three scenario outcomes. |
| `package.json` | Add `demo:cards`. |
| `ARCHITECTURE.md` | After implementation: a "Card slice" section with the file map and the two-tier flow. |
| `LEARNING.md` | After implementation: why the gate takes a digest instead of the contract; why the cart digest is recomputed. |

Fourteen files. This is a session, not a single change.

## Behavior

Gate (pure):

1. Given an active binding and an auth request with a permitted descriptor, amount at most the ceiling, inside the window, no cart, when `authorizeCard` runs, then the decision is `{ approved: true, tier: 'auth' }`.
2. Given the same request with `amount > ceiling`, then `{ approved: false, tier: 'auth', reasons: ['Amount exceeds ceiling'] }`.
3. Given a request whose `merchantDescriptor` is not in `merchantDescriptors`, then declined with `'Merchant descriptor not permitted'`.
4. Given a binding whose `status` is `'used'` or `'frozen'`, then declined with `'Card is used'` / `'Card is frozen'` and no further reasons.
5. Given a cart whose `booking` has dates 09-19..09-21 against a binding whose `purchaseDigest` was computed over 09-18..09-20, with amount equal to `exactTotal`, then `{ approved: false, tier: 'cart', reasons: ['Cart does not match the approved purchase'] }`. This is the demo's screen.
6. Given a cart whose `digest` field matches the binding but whose `booking` hashes to something else, then declined with `'Cart digest does not match its contents'` (the merchant lied about the digest).

Rail (fake):

7. Given an issued card, when `authorize` approves, then `binding(cardRef).status === 'used'`, and a second `authorize` on the same card is declined with `'Card is used'`.
8. Given an approved auth, when `capture(authRef)` runs, then `facts(operationKey)` contains one `captured` fact with the auth amount; when `refund(authRef, n)` runs, a `refunded` fact with the same `transactionRef` is appended.
9. Given a `TypedReceipt` whose `last4`, `merchantDescriptor`, and `amount` match one binding, when `matchReceipt` runs, then it returns `BookingEvidence` with `source: 'email'`, `operationKey` from the binding, and `booking` from the receipt; given no match, `undefined`.

Demo (`demo/cards.ts`), all three scenarios ratify the same hotel contract used in `demo/deterministic-authorization.ts` (duplicate the fixture; do not import from the other demo), with `merchantDescriptors = ['BOSTON HARBOR HOTEL']`:

10. **Accept merchant, cart drift.** The agent passes the correct candidate to `execute()` (preflight passes, card issued). `FakeAcceptMerchant` is configured with `driftDates: true`, so its cart carries 09-19..09-21. When it checks out, `authorize` is declined at tier `cart` per Behavior 5, the rail records one `unpaid` fact, and `reconcile()` assesses `failure` with `captured 0`, `unrecovered 0`. Screen shows: descriptor permitted, amount under ceiling, credential authentic, cart digest mismatch, `capture() calls: 0`.
11. **Web merchant, same drift, no cart.** Same setup with `FakeWebMerchant` (`driftDates: true`). `authorize` approves at tier `auth` (the auth message cannot see dates), `capture` posts $500, the merchant emits a receipt for 09-19..09-21, `matchReceipt` produces `BookingEvidence` source `email`, and `assessOutcome` returns `failure` with `unrecovered 500`. `requestRecovery('refund')` then `rail.refund(authRef, 500)` then `reconcile()` brings `unrecovered` to 0 and `mission.status` to `refunded`.
12. **Accept merchant, correct, then chargeback.** No drift. Approved at tier `cart`, captured, `BookingEvidence` source `merchant` confirmed, assessed `success`. Then `rail.chargeback(authRef, { category: 'notReceived', networkCode: '13.1', description: 'Merchandise or services not received' })` and `reconcile()`: assessment becomes `unknown` with the conflict reason, and `authority_stopped` is appended.

Service:

13. Given a `dispute_observed` with an `externalId` already recorded, when `recordDispute` runs, then nothing is appended (dedupe on `externalId`, same as payment facts).
14. Given a dispute whose `operationKey` differs from the mission's, then `recordDispute` throws `'Dispute belongs to another operation'`.

Domain boundary:

15. Given the source text of `src/cards/card-gate.ts` and `src/cards/card-rail.ts`, when every `import` line is inspected, then the only `../missions/` imports are `type HotelBooking` (and `type BookingEvidence`, `type PaymentFact` in the rail) from `types.js` and `canonical` from `outcome-assessor.js`. Any import of `agent-registry`, `mission-store`, or `purchase-mission-service` fails the test.

## Failure modes

| dependency fails | behavior | state left behind |
|---|---|---|
| `rail.issue()` throws inside `payments.issue()` | existing `execute()` path: caught, `operation_pending` appended, reservation kept | mission `outcome_pending`; no card exists; `reconcile()` finds no facts and stays `pending` |
| auth arrives after `revoke()` froze the card | declined `'Card is frozen'`; rail records `unpaid` | mission assesses `failure` with $0 captured |
| auth arrives after `expiresAt` | declined `'Card window closed'` | same |
| second auth on a used card (merchant retry) | declined `'Card is used'`; no second fact | first auth's facts unchanged |
| merchant sends cart with forged digest | Behavior 6 decline | `unpaid` fact |
| receipt matches no binding | `matchReceipt` returns `undefined`; caller logs and drops | no evidence appended; mission stays `pending` awaiting evidence |
| receipt matches two bindings (same last4, descriptor, amount) | `matchReceipt` returns `undefined` and the caller logs ambiguity; never guesses | as above |
| capture amount differs from `exactTotal` (auth tier only; e.g. $480) | captured, then existing assessor rule `'Captured payment differs from the approved purchase'` → `failure` | `unrecovered` = captured amount |
| chargeback arrives with no capture on record | `recordDispute` appends; assessor sees no `good`, returns `failure` | `unrecovered` unchanged (0) |
| process crashes mid-scenario | mission store is durable; `FakeCardRail` state is lost | `reconcile()` on restart finds no facts → `pending`. Out of scope to fix; a real issuer persists |
| concurrent `authorize` on one card | not possible: single-threaded in-process fake | n/a; a real issuer serializes per card |

## Verification

```
npm run build          # exit 0
npx tsc --noEmit       # exit 0
npm test               # exit 0; expect 253 + N passed, 8 skipped, where N ≥ 14 new cases across the three new files
npm run demo:cards     # exit 0
```

`npm run demo:cards` must print, for scenario 10, a block containing all of:

```
tier: cart
Cart does not match the approved purchase
capture() calls: 0
```

and for scenario 11 a line containing `unrecovered $500.00` followed later by `unrecovered $0.00`, and for scenario 12 the assessment `unknown` after the chargeback.

`tests/demo-cards.test.ts` asserts, from the returned result object:

```
acceptDrift.decision.tier === 'cart' && acceptDrift.decision.approved === false
acceptDrift.captureCalls === 0
webDrift.decision.approved === true && webDrift.decision.tier === 'auth'
webDrift.assessmentBeforeRefund === 'failure' && webDrift.unrecoveredBeforeRefund === 500
webDrift.unrecoveredAfterRefund === 0
clean.assessmentBeforeChargeback === 'success'
clean.assessmentAfterChargeback === 'unknown'
```

`tests/card-gate.test.ts` covers Behavior 1 to 6 as one `it` each, plus Behavior 15 as a test that reads both source files with `node:fs` and asserts on their import lines. `tests/card-rail.test.ts` covers Behavior 7 to 9 plus the frozen and expired rows of the failure table.

## Decisions taken

**Gate takes a digest, not the contract.** A real issuer would not hold the consumer's contract; it would hold what was bound at issuance. So `CardBinding` carries `purchaseDigest = sha256(canonical(contract.purchase))` and the cart tier is digest equality with recomputation. Cost: the gate cannot explain *which* field differs (dates vs room); the assessor, which does hold the contract, explains that post-hoc. Rejected: passing the `OutcomeContract` into the gate, which would make the fake unrepresentative of what Natural could run.

**Purchase digest, not contract digest.** `renderContract()` hashes goal, constraints, and policy, none of which a merchant sees. The merchant can only hash the order. Two digests therefore exist: the ratification digest (already in `MandateEvidence.renderedSummaryHash`) and the purchase digest on the card. They are not interchangeable and the code must not conflate them.

**Strict at cart tier, ceiling at auth tier.** The auth message cannot distinguish tax from substitution, so it gets only the ceiling. The cart tier has the order, so it demands equality. Capture is then judged by the existing assessor rule, which fails any capture that differs from the approved total. Cost: a real hotel that adds a resort fee at the desk will fail assessment. That is the exact-approval semantics the paper argues for; relaxing it is a product decision recorded in Open questions.

**Chargeback against a confirmed booking is `unknown`, not `failure`.** Merchant says delivered, cardholder says not; the existing rule for conflicting evidence is human review. Treating the dispute as authoritative would let a cardholder override merchant evidence unilaterally.

**New module beside the mission slice, not inside lease.ts.** `reserveCardPurchase()` is Ramp-shaped and lives in the stateful manager. The gate is pure and the rail is a fake; keeping them in `src/cards/` means `PurchaseMissionService` sees only the existing `PaymentCapabilityProvider` boundary. Cost: some duplication with `CardIssueRequest`, which is accepted.

**Cart drift originates at the merchant, not in the proposal.** `execute()` already runs `preflight()` on the agent's candidate, so a wrong-date *proposal* never reaches the card. The scenario that exercises the cart tier is a correct proposal whose checkout drifts (the agent mis-clicks on the merchant page, or availability shifts). The fakes model this with a `driftDates` switch. This is also the honest story: preflight sees the proposal, the gate sees the charge, the assessor sees the outcome, and each catches what the previous one cannot.

**Receipt matching is structured-only.** The fixture supplies a `TypedReceipt`; the parser that would produce one from an email is stubbed. Cost: the demo does not show extraction calibration for receipts, which §7.3 of the paper says is the interesting measurement. Recorded as an open question.

## Open questions

- Natural Cards: does the issuing-side authorization path expose anything from an Accept merchant's charge object (line items, order digest)? If not, the cart tier is a proposal, not a mapping. Ask them; do not infer from the event catalog.
- Whether a Natural card paying a Natural Accept merchant links both legs on one transaction record. The closed-loop claim depends on this.
- Tolerance at capture for taxes and fees. Strict equality is specified here; a product would need a declared tolerance in the ratified record, which is a contract-schema change, not a gate change.
- Should `CardBinding` carry `agentVersionId` so an issuer could decline when the version is revoked between issuance and auth? Deferred: the pre-dispatch check plus `freeze()` on revocation covers it in this slice.
- Receipt extraction calibration (silent mistyping vs correct refusal) is unmeasured.
- Whether `FakeCardRail` state should persist to SQLite so a crash mid-scenario is recoverable. Out of scope now; needed before any live-money test.
