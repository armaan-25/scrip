# Handoff: Scrip — agent-to-agent spend authorization

**Written:** 2026-09-02
**Branch:** `main`, all changes below are uncommitted in the working tree
**Verification gate:** none exists (`.claude/checks.sh` is absent) — the only proof this repo has of correctness is `npx tsc --noEmit` and `npm test`, both passing (170/170, 8 skipped — the 8 are Postgres-integration tests that need a local DB running)

## What this project is

Scrip is a task-execution spend-authorization engine that sits between AI agents and Ramp (the corporate spend-management fintech). It is **not** a payment rail or a card issuer — it never touches money custody. It's the authorization layer: one task gets a bounded budget, can hierarchically delegate bounded slices of that budget to sub-agents it spawns, tracks whether each delegated agent actually delivered, and adjusts that agent's future budget automatically based on its track record. Everything settles into one receipt; revocation cascades through every descendant in one call.

The core domain engine lives in `src/lease.ts` (`TaskAuthorizationManager`) and is provider-agnostic — it consumes `RampGateway`/`CardIssuer`/`PaymentExecutor` interfaces, not Ramp-specific code directly. Ramp is the first (and currently only) real adapter wired in.

## The actual competitive claim, and why it matters

This session ran deep, source-cited research (not assumption) confirming that **no product in the agentic-payments space supports hierarchical agent-to-agent delegation with trust-adjusted budgets**:

- **Ramp Agent Cards (OBOU model)** — real, shipped. Per-card ceiling enforced by Ramp. Flat: one human sponsor grants directly to one agent. `docs.ramp.com/developer-api/v1/agent-cards`.
- **Ramp Standalone Agents** — real, private-preview as of Aug 19 2026 (confirmed via Ramp's own `ramp-onboard-standalone-agent` skill file). Admin-provisioned one agent identity at a time. Still no agent-to-agent delegation mechanism.
- **Ramp x402** — real, shipped. Business-wide Ramp-managed Solana wallet, funded once from Ramp Checking. **Zero per-agent spend ceiling** — Ramp only checks wallet balance. All safety is procedural (confirm-before-signing), not architectural.
- **Ramp's own builders.ramp.com engineering blog** states, in `agent-identity-introduction`: *"While it was tempting to invest in building out the SA model in which agentic identity is independent from any single user... there were practical reasons for us to begin with OBOU."* — a direct admission they deferred exactly the capability Scrip provides. A full 49-post crawl of their blog found no other admission like this anywhere.
- **Natural (natural.com, $40M raised)** — real controls layer, but its own docs state limits are *"independent gates with no precedence... the tightest limit wins"* — flat, non-hierarchical, and enforcement is soft (a breach holds for human approval, never a hard block). Its Services Agreement defines "Agent" as authorized only by a human — agent-authorizing-agent is foreclosed by contract, not just undocumented. Also: **Natural's Authorized Use Policy prohibits building a competing product with their technology** — confirmed directly from `natural.com/aup`. Natural cannot be used as a rail without written permission.
- **Locus (paywithlocus.com, YC F25, $212M raised)** — the closest marketing claim to Scrip's actual mechanism ("orchestrator agent can delegate a portion of its budget to specialist agents... bounded by the parent's remaining resources"). **Directly verified as marketing-ahead-of-product**: their real execution-policy API (`PUT /credits/end-users/{externalUserId}/policy`) is flat — one policy per end-user, no parent-policy field, no sub-policy endpoint. Their own SDK/quickstart docs (cited by the marketing page itself) don't support the claim either. GitHub code search across their org for "delegat"/"sub-agent budget"/"parentPolicy" returned zero hits. A developer would have to hand-roll delegation in application code today, with no atomicity guarantee from Locus — exactly the gap `TaskAuthorizationManager.delegate()` closes.

**Bottom line for whoever picks this up:** the differentiation claim is real and independently verified three separate times (Ramp's own blog, Natural's docs/contract, Locus's actual API vs. its marketing). Don't re-litigate this without new evidence — it's solid. The open, unresolved question is whether this is worth building as a company (unanswered, and explicitly not the goal right now) versus as a portfolio/technical-credibility piece aimed at Ramp specifically (the actual stated goal — see project memory / prior conversation, not reproduced here).

## What's built, tested, and live-verified (do not re-derive, extend from here)

All of this is in `src/lease.ts` unless noted. 170/170 tests passing.

1. **`authorizeTask()`** — root budget for one task, Ramp-policy-enforced (`scrip.yaml`'s `max_task_allowance` per budget).
2. **`delegate()`** — hierarchical, atomically-bounded sub-budgets. Invariant: `available = allowance - spent - pending - delegated`. **Live-verified against a real Ramp sandbox** earlier this session (not just tested): a sub-agent independently minted its own real Ramp Agent Card from a delegated credential, and a sibling's over-budget ask was denied before any card was issued.
3. **`reserveCardPurchase()`** — mints a real, single-use Ramp Agent Card capped at the reservation amount, via `RampCliCardIssuer` (`src/ramp-agent-card.ts`), which shells out to the real `ramp` CLI. **Live-verified.**
4. **`reserveWalletPayment()`** (new this session) — the x402-shaped path: reserve-then-execute against a rail with no native ceiling. Proves Scrip's reservation math is the only enforcement (the payment executor is never called when the ask exceeds what's available — tested explicitly). **Tested, not yet live** — see below.
5. **`settleLease()` + `AgentTrackRecordStore`** (`src/store.ts`, new this session) — per-agent resolve rate, independent of the root task's own outcome. A lease settles its own success/failure via `settleLease(leaseId, outcome)`, separate from the root's `settleTask()`.
6. **Adaptive delegation cap** — `delegate()` consults `AgentTrackRecordStore.getResolveRate(agentId)` before granting. Below a configured resolve-rate threshold (`lowTrustResolveRateThreshold` on `RampBudgetConfig`, opt-in per budget via `scrip.yaml`), once enough settlement history exists (`minSettlementsForTrust`), the grant is clamped to `allowance * resolveRate` instead of the full ask. **Tested and demoed live** in `visuals/console.html` — an agent with a bad track record gets clamped to a fraction of a cent instead of being denied outright.
7. **`revokeTask()`** — cascades through every descendant lease in one call. Pre-existing, not new this session, but load-bearing for the "revocation cascade" claim.
8. **`sweepExpired()`** — auto-revokes anything past its deadline.

## What's built this session but NOT yet live

**`src/ramp-x402-gateway.ts` (`RampX402Executor`)** — the real adapter for `PaymentExecutor` (`src/payment-executor.ts`), implementing the actual x402 protocol flow against Ramp's real `ramp x402 pay` CLI command:
- Fetches a merchant's `402 Payment Required` challenge, base64url-decodes the `PAYMENT-REQUIRED` header
- Validates the challenge against x402's `exact` scheme / Solana mainnet / canonical USDC mint compatibility rules
- **Checks the challenge's real quoted amount against Scrip's own `maximumCost` ceiling BEFORE ever calling `ramp x402 pay`** — this is the actual enforcement claim, and it's tested (`tests/ramp-x402-gateway.test.ts`, 7 passing tests, mocking both `execFile` and `fetch`)
- Signs via `ramp x402 pay --json ...`, retries the original request with the `PAYMENT-SIGNATURE` header, decodes the `PAYMENT-RESPONSE` header for the real Solana transaction hash

Wired into `src/runtime.ts`'s `createPaymentExecutor()` with the same `RAMP_CLI_BIN` env-var precedence pattern as `createCardIssuer()`.

**Never executed against a real network.** No `ramp x402 fund` has been run — there is no funded wallet. This has never moved real USDC. That is the concrete next step if "prove this live" is the goal, and per the real x402 skill's own safety rules (`ramp-setup-x402-wallet`/`ramp-make-x402-payment`, both fetched verbatim earlier this session and available if needed), funding a wallet requires an account owner/admin's explicit confirmation — do not do this without asking first.

## What exists but is NOT wired in (do not assume otherwise)

- **`src/infrastructure/postgres/postgres-task-store.ts`** — a real, separate `PostgresTaskStore` class with its own `PgLease`/`PgTaskAuthorization` types exists, but `src/runtime.ts` never references it. Real-money mode today runs in-memory or against JSON files only (`LocalReceiptStore`, `AgentTrackRecordStore`, the lease `storePath`). If any future work claims "durable Postgres-backed state," verify this is still true before trusting it — it was true as of this handoff.
- **A "financial sandbox" product design** (Postgres wiring, hosted principal UI, webhook reconciliation, provider contract tests, a full task lifecycle state machine) was proposed as a design doc during this session and **explicitly not adopted** — treated as a reference for engineering rigor, not a build plan. Don't resurrect it as "the plan" without the user re-confirming; it was deliberately set aside as bigger than what's currently wanted.
- **A "hire a human contractor" scenario** (agent mints a real expense card for a human gig worker) was scoped and then explicitly rejected by the user mid-session ("wait we aren't hiring humans... that scenario is off the table"). Nothing was built for it. Do not build it unless re-requested.

## Demo / live surfaces

- `npm run visuals:console` → `visuals/console-server.ts` + `visuals/console.html`, port 8799. Live browser-driven demo: a root task authorizes $10, delegates to 3 agents (one has a seeded bad track record and gets visibly clamped), each agent's real browser session (via `playwright-cli`, non-interactive, no real purchase clicks) is watchable by clicking its row. This is the most complete, demonstrable proof of the whole mechanism working end to end — start here if asked to show the product working.
- A positioning brief artifact was published earlier this session (title: "The Standalone Agent Gap") — if asked to update or reference it, it needs to be re-fetched fresh (it was already found to have been edited by another session mid-conversation once already) rather than assumed current.

## Conventions to preserve

- Every Ramp CLI adapter (`RampCliCardIssuer`, `RampX402Executor`) duplicates its own minimal `execFileCapturingStdout` helper rather than sharing one — this is deliberate (see the comment in `ramp-agent-card.ts`), not an oversight to "fix."
- `runtime.ts`'s `createCardIssuer()`/`createPaymentExecutor()`/`createRampGateway()` all follow the same env-var precedence pattern: real adapter if `RAMP_CLI_BIN` (or equivalent) is set, else fall back through progressively more mocked options, logging which one was chosen. Extend this pattern, don't invent a new one.
- Tests mock `node:child_process`'s `execFile` via `vi.mock` + `vi.mocked`, with `mockExecFile.mockReset()` in `beforeEach` — a prior session hit real test-pollution bugs from a shared mock not being reset; keep doing this.
- Config additions (like `minSettlementsForTrust`) are optional on `RampBudgetConfig`, defaulting to "feature off," so existing `scrip.yaml` budgets that don't opt in are unaffected. Keep new features additive this way.

## Immediate open questions for whoever picks this up

1. Does the user want `RampX402Executor` proven live (real wallet funding, real USDC movement)? Needs explicit go-ahead — don't do it unprompted.
2. Is there a next feature to build, or is the priority now committing/cleaning up the 16 uncommitted files sitting in the working tree?
3. The user has been going back and forth between "build this as real infrastructure" and "this is a portfolio piece, don't over-scope it" — read the room before starting anything that takes more than an hour or two.
