# Scrip Consumer Outcome Wallet — Implementation Brief

**Status:** Full-product roadmap with historical hotel-baseline instructions below; updated September 16, 2026
**Authoritative product contract:** `SPEC.md`
**Goal:** Deliver the complete personal agentic payments wallet in `SPEC.md`, including connected funding, persistent versioned agents, multi-item mandates, consumer flows, outcome verification and recovery.

## Current scope and required continuation

The hotel service exists with fake providers and is the regression baseline, not the complete product. The September 16 audit reported 226 passed / 8 skipped including 50 expanded mission cases. Recheck before implementation; the 170-test count in `HANDOFF.md` is historical.

Follow the full consumer journey, identity/version, multi-item financial semantics and delivery-stage sections in `SPEC.md`. They supersede the narrower historical instructions below. Remaining stages are authenticated identity and mandates; general single/multi-item missions; connected funding and consumer application; real adapters, signed evidence and durable workers; a verified supported live release; then additional rails, transfers/machine payments, standing mandates, replacement/rebooking, confirmed disputes and reputation.

Keep contract versions separate from agent versions. Bind runtime credentials to trusted version records. Explicitly migrate dollar-based legacy contracts when introducing integer minor units. Multiple purchases require operation-level idempotency, basket allocations, partial outcomes and item recovery. Embedded and external agents use the same enforcement boundary. Each implementation stage needs scoped changes and its own acceptance evidence.

## Product decision

Scrip is not another generic agent-card API and is not “Natural for consumers.” It is an outcome-native consumer wallet:

> A consumer gives the wallet one bounded mission. Scrip records exactly what was approved, authorizes only a matching purchase, verifies whether the requested result occurred, and remains responsible through the permitted recovery path.

The reference mission is a refundable hotel booking. This gives the first slice machine-testable constraints, external execution, payment state, fulfillment evidence, cancellation terms, and a refund lifecycle.

## Read before changing code

1. Read `SPEC.md` completely. It is the source of truth for the consumer product, domain language, lifecycle, safety rules, and acceptance criteria.
2. Read `HANDOFF.md` for the current implementation and provider boundaries. Where its older product positioning conflicts with `SPEC.md`, follow `SPEC.md`.
3. Inspect `git status`, the current diff, and `.claude/checks.sh` if present. Preserve every unrelated or pre-existing modification.
4. Inspect the existing symbols before designing replacements, especially `TaskAuthorizationManager`, `reserveAction`, `commitAction`, `cancelAction`, revocation, receipts, and `RampGateway` (the finance boundary; `CardIssuer` and `PaymentExecutor` were removed with the Ramp integration on 2026-09-21).

Completion criterion: before editing, be able to name the existing symbol reused for reservation and the new module that will own the mission aggregate.

## Historical hotel baseline to preserve

The current baseline is a narrow hotel backbone using fake execution and payment adapters. Preserve the following behavior while generalizing it.

The supported flow is:

```text
Consumer creates a hotel mission
→ Scrip stores a draft OutcomeContract
→ consumer approves one immutable contract version
→ deterministic preflight checks the candidate booking
→ Scrip reserves the maximum cost before provider I/O
→ fake execution produces merchant and payment evidence
→ Scrip appends evidence and projects the current mission state
→ deterministic verification marks the outcome succeeded, failed, or pending
→ an allowed failure enters recovery_required without auto-filing a dispute
→ the receipt reports authorized, reserved, captured, refunded, and unrecovered amounts separately
```

### Required behavior

1. **Mission aggregate**
   - Add the `PurchaseMission`, `OutcomeContract`, contract-version, evidence, recovery-policy, and append-only event concepts defined in `SPEC.md`.
   - Keep machine-enforced constraints typed. Unknown or unresolved hard constraints block unattended execution.
   - Make the approved contract version immutable. A material change creates a new version and requires approval.

2. **Application service**
   - Support creating a draft, approving the exact rendered contract, evaluating preflight, executing once, verifying evidence, requesting an allowed recovery action, revoking the mission, and reading the complete receipt.
   - Keep transport concerns out of the aggregate. Add HTTP routes only if the domain slice is complete and the existing server can expose them without broad restructuring.

3. **Reservation boundary**
   - Reuse the existing `TaskAuthorizationManager` reservation lifecycle rather than introducing a second budget ledger.
   - Persist mission intent and the operation record before external I/O.
   - Reserve the maximum possible cost before execution, commit the authoritative captured amount, and cancel only unambiguous unpaid reservations.

4. **Idempotency and ambiguous operations**
   - Scope an execution key to the consumer, mission, approved contract version, and operation.
   - Enforce at-most-once effects with durable uniqueness in the selected store abstraction, not with an in-memory “seen” check alone.
   - A retry resumes or reconciles the original operation. It must never create a second purchase while the first payment state is unknown.

5. **Evidence and recovery**
   - The executing agent's narrative is not proof of success.
   - Store merchant, execution, email, and payment evidence as separately attributed events.
   - Treat a refund acknowledgment as `refund_pending`; only authoritative payment evidence can produce `refund_posted`.
   - Never auto-submit a card-network dispute. Preserve the explicit consumer-confirmation boundary from `SPEC.md`.

### Required tests

At minimum, prove:

- a draft has no spending authority;
- approval binds the exact contract version and rendered-summary hash;
- a merchant, amount, date, or refundability mismatch blocks payment before provider I/O;
- reservation happens before fake execution;
- two calls with the same execution key cause at most one external purchase effect;
- an ambiguous payment timeout does not retry the purchase;
- agent-authored prose alone cannot mark an outcome successful;
- a failed supported outcome enters `recovery_required`;
- refund acknowledgment and posted refund remain distinct events and balances;
- revocation disables future execution while preserving prior evidence;
- the final receipt distinguishes authorized, reserved, captured, refunded, returned, and unrecovered amounts.

Completion criterion: the tests demonstrate the complete draft-to-receipt flow with fake adapters and fail if reservation ordering, idempotency, or evidence independence is removed.

## Architecture boundaries

- **Scrip owns:** mission lifecycle, typed constraints, approval evidence, budget reservation, outcome evaluation, recovery orchestration, event history, and the final receipt.
- **Execution provider owns:** browser/API interaction and replay artifacts.
- **Payment provider owns:** scoped payment capability plus authoritative authorization, capture, reversal, refund, and dispute facts.
- **Identity/mandate standards:** preserve compatible AP2, Verifiable Intent, ACP, or provider artifacts as evidence. Do not create a proprietary KYA protocol in this slice.
- **Rail selection:** remain behind provider adapters. Do not build stablecoin routing, crypto-to-fiat conversion, custody, card issuance, or a dual-rail engine in this slice.
- **TEE:** defer enclave integration. A TEE may later isolate signing keys, but it cannot prove correct intent interpretation or merchant fulfillment.

## Engineering constraints

- Make the smallest coherent change that completes the vertical slice.
- Prefer explicit domain modules over expanding `src/lease.ts` into the consumer product layer.
- Preserve the existing provider interfaces and reservation invariants.
- Add no dependency unless the existing language/runtime cannot satisfy a concrete requirement; explain any addition before installing it.
- Do not fund x402, create a real card, send a real payment, file a dispute, or use Natural as a production rail.
- Update `ARCHITECTURE.md` and `LEARNING.md` only for architecture and concepts actually implemented.
- Record gaps honestly: fake-adapter evidence is not production payment, merchant, refund, or deployment verification.

## Verification and handoff

1. If `.claude/checks.sh` exists, run it exactly.
2. Run `npm run build` and `npm test`.
3. Report commands, exit codes, passed/skipped counts, and the lines that matter.
4. Review the final diff for unrelated changes and accidental credential/provider usage.
5. Explain the implemented end-to-end flow using exact repository files and symbols.
6. Report what remains fake, in-memory, unwired, or unverified.

The hotel baseline is verified through a fake-provider draft-to-receipt flow. Full-product completion additionally requires all consumer, multi-item, versioned-authority and selected-provider acceptance gates in `SPEC.md`. Documentation changes alone do not authorize live financial activity.
