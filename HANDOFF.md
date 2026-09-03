# Handoff: Scrip — agent-to-agent spend authorization

**Written:** 2026-09-02, updated 2026-09-03
**Branch:** `main`, HEAD is `99066dd` ("Add resolve-rate adaptive delegation caps and a real x402 payment executor") — **everything described below is committed**, not sitting in the working tree. `git status` is clean except two pre-existing, unrelated items not owned by this work: `.claude/worktrees/agent-credit/` (a separate exploration branch from before this session) and `SKILL.md` (repo-root skill descriptor, pre-existing). Don't fold either into anything you do.
**Verification gate:** none exists (`.claude/checks.sh` is absent) — the only proof this repo has of correctness is `npx tsc --noEmit` and `npm test`, both passing (170/170, 8 skipped — the 8 are Postgres-integration tests that need a local DB running). Re-confirmed clean as of 2026-09-03.

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

## Ramp's "AI spend value" / semantic layer posts (read in depth 2026-09-03, don't re-derive)

The user surfaced a Ramp Labs tweet about an internal "semantic layer" attributing AI agent spend to objectives/outcomes, asking whether Scrip should adapt to it. Two posts were fetched and read directly (not just summarized from the tweet):

- **`builders.ramp.com/post/ai-spend-value`** — "You're Spending Too Much on AI. You're Also Using Too Little." Business-philosophy piece, not a technical spec. Says to "translate spend into units of work" but gives no schema, no attribution algorithm, no outcome verification — defers to their AI Token Spend Management product instead of explaining the mechanism.
- **`builders.ramp.com/post/ai-token-spend-management`** — the real technical post. Pipeline: LiteLLM/OpenRouter → Kafka → ClickHouse, `ReplacingMergeTree` for exactly-once event dedup, per-token cost precision, attribution via `user_id`/`team_id`/manually-injected metadata tags (`project`, `environment`) and a use-case taxonomy (`code-generation`, `summarization`, etc.).

**Verdict, already given to the user, don't re-litigate without new evidence:** this is a categorization/analytics layer, not a proof-of-work layer. It has no mechanism linking a spend event to a *verified* outcome — the tags driving all its "type of work" attribution are self-reported by developers with no enforcement mentioned anywhere. Scrip's `settleLease()` + `OutcomeVerifier` + resolve-rate mechanism already does the harder thing this system doesn't attempt: gating trust on verified outcomes, not self-reported tags. **Adapting Scrip toward Ramp's model would be a step backward on rigor.** The one thing worth borrowing, if anything, is narrower: their observability-pipeline pattern (structured event log, exactly-once semantics) as a way to make Scrip's existing receipts more queryable — additive, not a redesign of how outcomes get proven.

## Three candidate next-project ideas (ranked 2026-09-03, evaluated fresh, not vs. Scrip's current state)

The user proposed three ideas for what to build next (explicitly as separate/fresh ideas, not a revival of the "financial sandbox" design doc mentioned below):

1. **Agent financial sandbox** (human gives an agent one task/budget/merchants/expiry, replayable receipts, build with fake money first) — real merit, but least differentiated: it's substantially the same primitives already in `TaskAuthorizationManager` repackaged as a standalone product spec. Lower marginal learning unless the goal shifts to packaging/productizing rather than new mechanism.
2. **Agent runtime debugger** (replay a run, show where money/latency/tool-calls/quality went wrong — the Wafer/Vals/Blacksmith-adjacent space) — assessed as the most interesting: genuinely different territory (observability/causality-reconstruction, not authorization), different data model (traces/spans, not budgets/leases).
3. **Agent "black box" recorder** (capture browser state/tool calls/screenshots/approvals for reproducing failed real-world tasks) — assessed as a *subset* of #2, not a separate project; it's #2's data-capture layer without the analysis layer.

**Recommendation given, not yet acted on:** build #2, with #3 as its first slice (capture before analysis). #1 has merit but risks being "redo what's already built, under a new name." No code has been written for any of these three — this is pure evaluation, nothing to extend from yet.

## Known environment constraint (2026-09-03)

This session has no working browser-automation/computer-use tool, despite the user enabling a "Computer-use MCP Server" mid-session (confirmed connected via their local `/mcp` terminal view, 24 tools reported). Repeated `ToolSearch` calls for browser/computer/screenshot/click-shaped tools returned nothing, even after the user reconnected it. Working theory: MCP tool attachment happens at session start, not hot-reloaded mid-session — a fresh `claude` session in this repo may pick it up, but this session never did. **Do not assume a browser/computer-use tool is available without checking `ToolSearch` fresh** — and if it's still absent, ask the user to paste text/screenshots directly (this worked fine for reading two X/Twitter posts this session; `WebFetch` cannot reach x.com at all, it returns a generic HTTP 402 block).

## Immediate open questions for whoever picks this up

1. Does the user want `RampX402Executor` proven live (real wallet funding, real USDC movement)? Needs explicit go-ahead — don't do it unprompted.
2. Nothing is uncommitted anymore — the "clean up the working tree" question from the prior version of this doc is resolved. The next real question is which of the three ranked ideas above (if any) to actually start, or whether to keep extending the current Ramp-specific direction (e.g. proving `RampX402Executor` live).
3. The user has been going back and forth between "build this as real infrastructure" and "this is a portfolio piece, don't over-scope it" — read the room before starting anything that takes more than an hour or two.
