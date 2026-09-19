# Scrip Learning Notes

## Consumer hotel mission implementation

- **Approval as a versioned value.** `renderContract()` serializes every
  contract field in deterministic order and hashes the exact rendered text.
  `PurchaseMissionService.approve()` checks both version and hash. Changing a
  quote requires `revise()` and another approval; changing a returned object
  cannot mutate the stored mandate. The alternative, approving only an amount,
  would lose the merchant, room, dates, and cancellation terms.
- **Event sourcing.** `SqliteMissionStore.append()` adds immutable facts and
  `projectMission()` reconstructs the current state. Captures and refunds
  remain separate events. SQL triggers reject updates/deletes of event rows.
  This is more work than overwriting one status row, but preserves conflicting
  evidence and lets the receipt distinguish a promise from a posted refund.
- **One transactional money ledger.** `LeaseStateStore` lets the unchanged
  reservation math save its state into SQLite. The service constructs a fresh
  `TaskAuthorizationManager` inside each transaction; its state and the
  corresponding mission event either commit together or roll back together.
  Separate JSON writes would leave crash windows between money and evidence.
  The raw root credential only lives between authorizeTask and reserveAction;
  stored lease state retains the existing hashed-credential representation.
- **At-most-once dispatch is a durable claim.** SQLite uniqueness binds the
  operation to consumer, mission, version, and action. A restart resumes by
  polling that operation, never by purchasing again. This deliberately trades
  automatic retry availability for safety: a crash before issuance may leave
  a hold that needs authoritative unpaid reconciliation. It is not a claim
  that arbitrary providers support exactly-once effects.
- **Independent verification.** `assessOutcome()` requires matching merchant
  or email booking facts plus an authoritative payment capture. The execution
  provider's narrative is retained but does not count as proof. Conflicting
  booking facts yield unknown and stop provider authority for consumer review.
- **Revocation is not reimbursement.** `revokeTask(..., { preservePending:
  true })` disables all leases while keeping unknown payment holds. A later
  capture can still commit. `requestRecovery()` may ask the merchant for a
  refund; only payment-provider evidence increases refunded dollars. Returned
  unused authority, refunded money, and unrecovered spend are different values.
- **Native runtime APIs.** The slice uses Node's `node:sqlite` (`DatabaseSync`,
  prepared SQL statements, transactions), `node:crypto` for deterministic
  hashes, and the existing Zod dependency for validation. `createRequire()`
  bypasses the old test bundler's missing built-in module recognition. Use
  Node 24+; the tested Node 25.1.0 runtime still emits an experimental SQLite
  warning. No npm dependency was added.

Read `tests/purchase-mission-service.test.ts` for the fake hotel adapter and
the draft → approval → reserve → capture → verification → recovery receipt
flow. Its subprocess test actually exits after the durable reservation and
reopens the database, demonstrating why an in-memory duplicate-request set
would be insufficient. Fake evidence proves these domain boundaries, not
merchant reliability, live refunds, deployed authentication, or provider terms.

## Concepts demonstrated

- A bearer credential proves possession, so it must be short-lived, scoped,
  revocable, and never logged. Scrip hashes credentials with Node's
  `crypto.createHash()` and compares hashes with `timingSafeEqual()`.
- The credential is not the primitive — the **lease** is. `InferenceLease`
  holds the actual state (remaining/reserved/delegated budget, expiry,
  depth); the credential is just its bearer handle. Design a system's real
  unit of authority first, then decide what proves possession of it.
- An allowance is not enough for concurrent agents. Pending reservations
  must count against the cap before slow provider requests start, or two
  valid calls can overspend together. This is the same "reserve, then
  commit or release" pattern as a database transaction or a payment
  authorization hold — not a novel idea, just applied to inference cost.
- Delegation is attenuation: a child credential can have less authority
  than its parent, never more. Two additional bounds on top of that:
  a **hard depth ceiling** (independent of money — stops a runaway
  recursive-spawn bug even on a large budget) and a **budget-adaptive
  minimum-viable-allowance floor** (computed against the cheapest allowed
  model's price, so how deep a chain can go is also naturally curtailed by
  economics, not just a fixed number).
- `max_tokens` provides an output-cost ceiling. Scrip combines it with a
  conservative input ceiling derived from message bytes and the price
  table, so a caller cannot bypass enforcement merely by understating a
  token estimate.
- Configured policy that's never read is a silent bug, not a no-op. This
  project shipped with `on_limit: 'degrade' | 'request-approval' | 'deny'`
  fully typed and set in `scrip.yaml` for a real span of time while the
  code that should have read it — `ScripClient.run()` — never did, so
  every budget behaved like `deny` regardless of configuration. Worth
  checking, in any config-driven system: is every declared field actually
  consumed somewhere, or does some of it just look like it's working?
- Settlement is task-level. Individual calls become usage events; the
  durable financial artifact is one receipt with actual spend, returned
  allowance, child count, request count, per-model totals, and an
  `outcome`/`outcomeEvidence` pair — a receipt should be able to answer
  "did the work this money paid for actually succeed," not just "was the
  spend authorized."
- Deterministic evidence beats self-reported success. `ApprovalController`
  judges *mid-task continuation* from a structured snapshot; `OutcomeVerifier`
  judges a *finished* outcome from external, non-self-reported state (a
  merged PR, passing CI). They look similar (both avoid asking a model to
  grade its own work) but answer different questions - worth keeping the
  distinction explicit rather than merging them into one "AI judges
  itself" concept with two call sites.
- A big rename across a real, tested codebase is safer staged as
  types-then-fields than done in one pass. Type-name aliases
  (`export type TaskExecution = TaskAuthorization`) let new code and docs
  use new vocabulary immediately, with zero risk to the ~100 existing
  tests that assert on old field names - the mechanical, whole-repo
  field-level rename (`allowance`→`authorizedUsd`) is real work, staged
  separately, not skipped.
- Don't archive a document before its replacement exists. Mid-pivot, 3 CLI
  design docs got moved to `docs/archive/` because a *future* CLI reshape
  would supersede them - except that reshape was never actually built in
  the same pass, so the docs describing the real, current, working CLI
  would have been the only ones marked "obsolete." Caught by rereading the
  archived files' own claims against what the code actually does, not by
  assuming the classification made in a Phase-0 audit was still correct
  by the time Phase 1 executed it days (or, here, minutes) later.

## Verifying claims against primary sources, not memory

Every architectural claim this project makes about Ramp's product surface
(Funds, AI Usage Tracking, Agent Cards, AI cost monitoring) was checked by
reading Ramp's own current docs directly, not recalled from training data —
API surfaces and product positioning change, and "I believe Ramp does X" is
a materially weaker claim than "Ramp's docs, fetched just now, say X." Where
something couldn't be verified (exact response field names for the Funds
balance endpoint, the sandbox request form's fields before actually seeing
it), that was stated as an open question rather than filled in with a
plausible guess.

## Package responsibilities

- `@anthropic-ai/sdk` and `openai` each perform their own provider's
  request and return token usage; `ModelProvider` is the interface that
  keeps `ScripClient`/`ApprovalController` from importing either directly.
- `js-yaml` loads human-readable Ramp budget mappings from `scrip.yaml`.
- `@modelcontextprotocol/sdk` and `zod` power the optional MCP adapter and
  its input validation. Neither owns policy or persistence.
- Vitest exercises the lifecycle without making billed API calls; where a
  scenario needs to be seen rather than just asserted on,
  `scripts/demo-flagship.ts` reproduces it against the real enforcement
  code with fake provider/GitHub clients — deterministic, free, and honest
  about which parts are real (every reservation/commit/release call) versus
  stubbed (model and GitHub responses).

No new package was added for the execution-economics pivot's first slice
(`OutcomeVerifier`/`GithubPrOutcomeVerifier` use the built-in `fetch`, same
DI pattern as `RampOAuthClient`); Node's standard `crypto` module remains
sufficient for opaque credential generation and hashing.


## Agent identity vs. contract versioning (September 16, 2026)

Two version axes that must not be conflated: `OutcomeContract.version` is
what the human authorized; `AgentVersion.versionId` is which software
exercises it. They change for different reasons and at different rates.
Implemented as separate aggregates in separate SQLite databases
(`SqliteMissionStore`, `SqliteAgentRegistry`) rather than as fields on the
contract - embedding them would force a contract revision on every agent
upgrade.

Concepts demonstrated:

- **Capability vs. identifier.** A lineage ID names an agent; it grants
  nothing. Authority comes from a mandate's explicit `authorizedVersionIds`
  allow-list, so a new version is unauthorized by construction.
- **Bearer-secret authentication.** `issueCredential()` returns the secret
  once; only a SHA-256 hash is stored. `authenticate()` compares with
  `timingSafeEqual()` so credential checking cannot be timed.
- **Epoch-based replay rejection.** `AgentVersion.revocationEpoch` is a
  monotonic counter; credentials record the epoch at issuance. Revocation
  increments it, so a previously valid secret fails the epoch comparison -
  rollback-and-replay is rejected without maintaining a revocation list.
- **Canonical serialization before hashing.** `canonicalManifest()` sorts
  object keys, tool entries, and permission arrays so the digest depends on
  content rather than property order. Same technique as the mission layer's
  `canonical()`.
- **Fail-closed classification.** An unrecognized or unclassified change
  yields `require_review`, never `retain`. `strictestTransition()` reduces a
  change set to its most severe transition.
- **Transaction rollback discards events.** Appending an audit record inside
  the transaction you are about to abort loses it. Refusals are written in
  their own transaction afterwards.

No new dependency: `node:sqlite` (already used by the mission store) and
`node:crypto` cover persistence, hashing, and constant-time comparison.
