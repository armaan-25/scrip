# Architecture

How Scrip is built: the layers, one purchase end to end, where state lives,
how failures propagate, and why it is shaped this way. For how it sits on
Natural specifically, see [natural.md](natural.md).

Everything runs in one Node process with two SQLite files. The only network
calls are to Natural, and only with `SCRIP_RAIL=natural`.

```text
┌─ Person ───────────────────────────────────────────────────────────┐
│ approves one exact purchase                                        │
└────────────────────────────────┬───────────────────────────────────┘
┌─ Scrip ────────────────────────▼───────────────────────────────────┐
│ PurchaseMissionService   approve → execute → reconcile → recover   │
│ SqliteAgentRegistry      agent version, credential, mandate        │
│ TaskAuthorizationManager holds and settles the approved ceiling    │
│ openRecoveryCase         evidence packet, refund request           │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ PaymentCapabilityProvider
┌─ Payment side ─────────────────▼───────────────────────────────────┐
│ NaturalSettlementProvider      LIVE, wraps the provider below      │
│   └ CardPaymentCapabilityProvider → SimulatedIssuer → card gate    │
│ SimulatedAcceptMerchant (signed orders) / SimulatedWebMerchant     │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ @naturalpay/sdk
                          ┌──────▼──────┐
                          │   Natural   │  wallet ⇄ "simulated merchant" wallet
                          └─────────────┘
```

The mission service only talks to `PaymentCapabilityProvider`, four methods
defined in `src/missions/types.ts`: `issue`, `getFacts`, `revoke`,
`requestRecovery`. It does not know whether a simulated card or Natural is
behind it, which is why switching on Natural changes no mission code.

## One purchase, end to end

```text
APPROVE    service.create(terms) → renderApproval() → contract hash
           registry.createMandate(contract hash, authorizedVersionIds = [this version])
           service.approve(...)                      events appended to missions.sqlite

EXECUTE    service.execute(credential, candidate)
           → registry.authenticate()                 forged or revoked credential → refused
           → preflight(contract, candidate)          any field differs → refused, nothing held
           → ledger.reserveAction('purchase', cap)   ceiling held
           → payments.issue()                        card bound to the purchase fingerprint
           → checkAuthority('pre_dispatch')          revocation since issue → stop here

AUTHORIZE  merchant.checkout(card) → SimulatedIssuer.authorize()
           → authorizeCard()          merchant, amount, currency, window, single use
           → verifyMerchantOrder()    signed order's fingerprint == card's fingerprint
           → approved: capture fact   declined: no fact, nothing moved

SETTLE     service.reconcile() → payments.getFacts()
           → NaturalSettlementProvider: $1.00 transfer, tagged, polled to COMPLETED
           → payment fact carries Natural's transfer id

VERIFY     assessOutcome(): payment fact + merchant evidence vs the approval
           → ledger.commitAction() → settleTask() → receipt

RECOVER    openRecoveryCase() → evidence packet → requestRecovery('refund')
           → refund pending until the reverse transfer posts → unrecovered $0
```

## Where state lives

| state | where |
|---|---|
| Mission events, ledger state, receipts | `missions.sqlite` via `SqliteMissionStore`. Append-only events; ledger state is saved in the same transaction. |
| Agent lineage, versions, credentials, mandates | `agents.sqlite` via `SqliteAgentRegistry`. Secrets stored hashed. |
| Card bindings and issuer decisions | Memory, inside `SimulatedIssuer`. |
| Money | Natural. Scrip keeps only transfer ids. |

The demo writes both SQLite files to a temp directory and deletes them on
exit; only Natural's transfers persist.

## How failures propagate

- **Bad credential or failed preflight:** refused before anything is held;
  Natural is never called.
- **Issuer decline:** no payment fact, so nothing to settle; the hold is
  released when the mission is cancelled.
- **Transfer not `COMPLETED`** within 60 seconds: reconcile fails and the
  mission has no payment fact. A retry reuses the same idempotency key.
- **Revocation mid-flight:** new spending is blocked, but an in-flight hold is
  preserved, so a charge already dispatched can still settle against it.
- **Payment result unknown:** the hold stays until authoritative evidence
  arrives. Only a confirmed unpaid result releases it.

## Design choices

- **The card gate takes a fingerprint, not the contract.** A real issuer would
  hold only what was bound at issuance. The cost is that the gate can't say
  which field differed; Scrip's assessor, on its own side, can.
- **Two fingerprints.** The contract hash covers the goal, constraints, and
  policy. The purchase fingerprint covers the booking alone, because that is
  all a merchant can hash.
- **Two authority checks.** Once before holding money, and again right before
  the agent is dispatched, because a revocation can arrive in between. A
  refusal is written in its own transaction so rolling back the attempt
  doesn't erase the record of it.
- **Agent upgrades earn no authority.** A new agent version is never added to
  an existing mandate automatically. A code or dependency change always
  requires review, whatever its version label says.
- **The gate is isolated.** `src/cards/card-gate.ts` imports nothing from the
  mission service, registry, or store, and a test enforces it, so it can move
  into an issuer as-is.

## The ledger underneath

`src/lease.ts` owns `TaskAuthorizationManager`, which reserves and settles the
approved ceiling for each purchase.

- **`TaskAuthorization`**: one per task. It holds an allowance drawn from a
  budget in `scrip.yaml`, `spent`/`pending` totals, a status
  (`active`/`settled`/`revoked`), and a TTL.
- **`Lease`**: a credential-bearing slice of the authorization, one per agent.
  The root lease is depth 0. `delegate()` issues child leases for sub-agents,
  carved from what the parent has left
  (`allowance - spent - pending - delegated`) and capped in depth by
  `max_delegation_depth`.
- **`ActionReservation`**: an atomic hold. `reserveAction()` holds the maximum
  against both the lease and the task; `commitAction()` records the actual
  cost or `cancelAction()` releases it. Concurrent agents can never
  oversubscribe the allowance.
- **Revocation** cascades to every lease under the task. With
  `preservePending`, holds already in flight stay open so a dispatched charge
  can still settle against them.
- **Credentials** are opaque `scrip_<random>` strings, stored as SHA-256
  hashes and compared in constant time.

The ledger persists through a `LeaseStateStore`; the only implementation keeps
it in a row of `missions.sqlite`, written in the same transaction as the
mission events. It reports settled receipts through `FinanceGateway` in
`src/store.ts`.

## Files

| path | owns |
|---|---|
| `src/missions/purchase-mission-service.ts` | The mission lifecycle: approve, execute, reconcile, verify, recover, cancel, receipts. |
| `src/missions/types.ts` | The contract, mission, events, receipts, and the provider interfaces. |
| `src/missions/outcome-assessor.ts` | Contract rendering and hash, `preflight()`, `assessOutcome()`. |
| `src/missions/mission-store.ts` | Append-only SQLite event store with optimistic concurrency. |
| `src/missions/agent-identity.ts`, `agent-registry.ts` | Agent lineage, versions, credentials, mandates, change classification. |
| `src/cards/card-gate.ts` | The two-tier issuer gate. Pure. |
| `src/cards/simulated-rail.ts` | Simulated issuer and the two simulated merchants. |
| `src/cards/card-payments.ts` | Adapts the simulated issuer to `PaymentCapabilityProvider`. |
| `src/protect/recovery-case.ts` | Evidence packet and refund request. |
| `src/rails/natural-settlement.ts` | The live Natural adapter. |
| `src/lease.ts`, `src/store.ts`, `src/config.ts` | The ledger underneath: atomic reserve/commit/cancel for one authorized task and its delegated workers, with attenuated delegation and cascading revocation. |
| `demo/protect.ts`, `visuals/` | The demo, in the terminal and as a page. |
| `scripts/natural-verify-live.ts` | Reads the live transfers back from Natural. |

Stack: TypeScript on Node 24, `node:sqlite` and `node:crypto`, `zod` for input
validation, `js-yaml` for `scrip.yaml`, `@naturalpay/sdk` for the live rail,
`chalk` for terminal output, Vitest for tests.

## What this does not establish

- **That the declared agent software actually ran.** Registration is
  self-declared; the version digest detects changes to the record, not to the
  running program.
- **That merchant evidence is authentic.** A record labeled as from the
  merchant is only as trustworthy as the adapter that produced it.
- **Production payment safety.** One purchase category (hotels), simulated
  card and merchants, and a one-dollar live leg. No dispute filing and no
  fault judgment.

## History

Scrip began as a spend-authorization layer for autonomous agents: task
allowances, delegated worker leases, and atomic reservations across concurrent
subagents. That ledger is what the purchase flow still settles through.
