# Pivot Audit — Phase 0

> Produced per the "execution-economics platform" pivot instruction.
> This document is the required output of Phase 0 only: inspection,
> baseline, classification, proposed sequence. **No production code has
> been touched.** Everything below is a proposal awaiting review.

> **Post-Phase-0 correction (during Phase 1):** §3 originally classified
> `docs/superpowers/specs/2026-07-22-cli-design.md`,
> `docs/superpowers/plans/2026-07-22-cli-interface.md`, and
> `docs/superpowers/specs/2026-07-22-cli-styling-design.md` as **ARCHIVE**,
> reasoning that the pivot's task/action-oriented CLI shape supersedes
> them. That reshape was never actually implemented (Phase 2 prioritized
> the domain rename, outcome verification, and the flagship demo instead -
> see the migration log below). Archiving those docs before their
> replacement existed would have left the real, current, working CLI
> without accurate documentation. They were moved to `docs/archive/`
> and then moved back, with a corrected in-doc note ("still the current
> CLI") instead of an "obsolete" claim that wasn't true yet. If the CLI
> reshape is done later, archive them then, not before.

## 1. Baseline status (verified, not asserted)

Run just now, on `main`, clean working tree, HEAD `d238f40`:

```
npm test   -> 15 test files, 93 tests, all passing
npm build  -> tsc -p tsconfig.json, no errors
```

- 42 commits on `main`.
- 42 TypeScript files under `src/`, `bin/`, `demo/`, `scripts/` (excluding `tests/`).
- 1,650 lines across `src/*.ts` + `src/providers/*.ts`.
- 1,497 lines across `tests/*.ts` (15 files, one per source module almost 1:1).
- Real, live-verified integrations today: Ramp OAuth (client-credentials,
  HTTP Basic Auth), Ramp Funds reads, Ramp AI Usage Tracking writes,
  Anthropic inference, OpenAI inference (multi-provider). MCP server
  verified with a real subprocess + real protocol client. CLI verified
  live against real Ramp across separate processes.
- Every external dependency (Ramp, Anthropic, OpenAI) is faked in unit
  tests via dependency injection; real-API verification happens only in
  standalone `scripts/smoke-test-*.ts` and by running the demos — this
  discipline caught two real bugs (a double Fund-ID resolution bug, an
  undocumented-but-required `usage.meters` field) that fakes-only tests
  did not catch.

## 2. Current domain model (what exists today, for reference)

```
TaskAuthorization  (src/lease.ts)        — one per top-level task
InferenceLease     (src/lease.ts)        — one per agent in the delegation tree
ActionReservation  (src/lease.ts)        — generic atomic reserve/commit/cancel unit,
                                            already type-tagged: 'inference' | 'paid_api'
                                            | 'purchase' | 'other'
ModelUsage/ActionUsage (src/store.ts)    — per-model / per-action-type aggregates
TaskReceipt         (src/store.ts)       — final settlement artifact, already carries
                                            outcome/outcomeEvidence, modelUsage, actionUsage
```

**Important correction to the pivot brief's framing:** the brief describes
the current model as strictly inference-centric
(`TaskAuthorization → InferenceLease → ProviderRequest → ModelUsage → TaskReceipt`)
and proposes generalizing it. That generalization was already done, in
this repo, on 2026-07-21 (`docs/superpowers/specs/2026-07-21-generic-action-reservation-design.md`,
commit history around `ActionReservation`/`reserveAction`/`commitAction`).
`ActionReservation` is not new — it's the exact `EconomicAction` lifecycle
the brief asks for, already shipped, already covering `paid_api` and
`purchase` action types, already proven end to end in
`scripts/demo-generic-action.ts`. The remaining gap is narrower than the
brief assumes: **naming and framing are inference-centric even though the
underlying mechanism already isn't.** This changes the risk profile of
Phase 2 (domain rename) from "build a new generalized model" to "rename
an already-generalized model and extend its type surface" — lower risk,
but still real work, since every call site, test, and doc uses the old
names today.

## 3. File-by-file classification

Legend: **KEEP** (no change), **GENERALIZE** (rename/extend, logic mostly
survives), **REPLACE** (new implementation needed), **DELETE** (remove
outright), **ARCHIVE** (move to `docs/archive/` with a header, don't
delete history).

### Core domain (`src/`)

| File | Verdict | Why |
|---|---|---|
| `src/lease.ts` | **GENERALIZE** | `TaskAuthorization`→`TaskExecution`, `InferenceLease`→`ExecutionLease`, `ActionReservation`→`EconomicAction` (already the right shape, needs the `actionId`/`parentActionId`/`status` lifecycle fields the brief specifies, and a `ResourceLimits`/`CapabilityPolicy` envelope beyond just `maxDelegationDepth`+token floors). The atomic reservation math (`available = allowance - spent - pending - delegated`) is the invariant to preserve byte-for-byte — see §5. `reserveRequest`/`commitRequest`/`cancelRequest` become the "compatibility wrapper" pattern the brief explicitly asks for. This is the highest-value, highest-risk file in the whole pivot: 478 lines, 20 tests directly against it, and every other module depends on its exported types.
| `src/store.ts` | **GENERALIZE** | `TaskReceipt` gains the `costs` breakdown by action type (inference/paid_api/cloud_compute/purchases/approval_overhead/other), `workerCount`/`actionCount`, and structured `outcome.evidence: OutcomeEvidence[]` instead of a single `outcomeEvidence?: string`. `RampGateway` interface survives close to as-is — it's already provider-neutral (`getReportedSpend`/`reportTaskUsage`), which is exactly the `FinanceControlPlane` shape the brief asks for (see §7). `LocalReceiptStore`/`MockRampGateway` survive as the "local durable write" / "local fallback adapter" the brief wants kept.
| `src/proxy.ts` | **GENERALIZE** | `ScripClient` is inference-specific by design today (it's literally "the provider proxy"). Under the new framing this becomes one caller of the generic `EconomicAction` lifecycle, not a separate concept — no rename needed to the class itself (it genuinely is the inference-calling piece), but its language in comments/docs needs to stop implying it's *the* enforcement mechanism rather than *an* action type.
| `src/approval-controller.ts` | **KEEP** | Directly matches the brief's "approval controller may remain available for exceptions, deterministic evidence preferred when possible." No change to the evidence-based design — it's already exactly what the brief describes wanting to avoid ("ask an LLM to declare success based only on the worker's own narrative") is a different thing: the approval controller judges *mid-task continuation*, not *outcome verification*. Keep both concepts distinct; don't conflate.
| `src/pricing.ts`, `src/pricing/model_price.json` | **KEEP** | Provider-tagged pricing table is orthogonal to this pivot. No change.
| `src/router.ts` (`BudgetRouter`) | **REPLACE-OR-DELETE, pending a decision — see §8 open question** | The brief is explicit: "Do not market model selection as Scrip's wedge," offers three options (delete / keep as tiny fallback helper / move behind an adapter). Recommendation below; needs your call before Phase 2, not decided unilaterally here.
| `src/config.ts` | **GENERALIZE** | `RampBudgetConfig` gains the `ResourceLimits`/`CapabilityPolicy` fields (`maxSubagents`, `maxConcurrency`, `maxWallClockSeconds`, `allowedTools`, `requiresApprovalAboveUsd`). `scrip.yaml`'s shape extends; existing fields (`allowed_models`, `on_limit`, `max_delegation_depth`, etc.) survive unchanged as a subset.
| `src/runtime.ts` | **GENERALIZE** | Composition root survives; wires the renamed manager instead of `TaskAuthorizationManager` once that's renamed. `createRampGateway()` becomes `createFinanceControlPlane()` or similar per §7.
| `src/handlers.ts` | **GENERALIZE** | Function names follow the domain rename (`authorizeTask`→`authorizeExecution` or similar) but the transport-independent-operations pattern itself is exactly right and survives unchanged in shape.
| `src/mcp-server.ts` | **GENERALIZE** | Tool names/descriptions follow the rename. Structurally: already correctly "thin, no business rules" per the brief's MCP requirement. `revokeTask` should be added as a 5th tool (today it's only in the CLI) since the brief's MCP command list includes revoke.
| `src/cli.ts`, `bin/cli.ts` | **GENERALIZE** | Command verbs change shape per the brief (`scrip task authorize`, `scrip action reserve`, etc. — a two-level subcommand structure) vs. today's flat `scrip authorize`. This is a real breaking change to the CLI shipped one conversation turn ago; see §6 risk notes. `bin/cli.ts`'s lease-persistence fix (`SCRIP_LEASE_STORE`) is infrastructure, not positioning — survives regardless of naming.
| `src/providers/model-provider.ts`, `anthropic-provider.ts`, `openai-provider.ts` | **KEEP**, relocate | Logic is correct and provider-neutral already. Per the brief's proposed tree, these move to `src/infrastructure/providers/*-adapter.ts` — a path change, not a logic change.
| `src/ramp-oauth.ts`, `src/ramp-api-gateway.ts`, `src/meter.ts` | **KEEP**, relocate | Real, live-verified, correct. Move to `src/infrastructure/ramp/*` per the brief's tree. No logic change. This is explicitly called out in the brief as "keep": real Ramp OAuth, Funds reads, AI usage broadcast, local fallback adapter, best-effort reporting after local durable settlement — all already true today.

### Entry points (`bin/`, `demo/`)

| File | Verdict | Why |
|---|---|---|
| `bin/mcp-server.ts` | **KEEP**, trivial rename follow-through | Thin bootstrap, survives as-is structurally.
| `demo/run-demo.ts` | **KEEP as flagship, needs rework** | This is the closest existing thing to the brief's "flagship demo" (real Anthropic calls, real Ramp Fund reads, multiple children, one settled receipt). It's missing: concurrent-reservation-denial in the same run (currently all children succeed), and any outcome verification step. Recommend evolving this into the flagship rather than writing a new one from scratch — see Phase 6 in §6.

### Scripts (`scripts/`)

| File | Verdict | Why |
|---|---|---|
| `scripts/demo-scenario.ts` | **KEEP** | This is the one that already proves "some work admitted, some denied before provider execution" — closest match to the brief's flagship-demo requirements list. Strong candidate to merge into/become the flagship rather than being redundant with it.
| `scripts/demo-generic-action.ts` | **ARCHIVE** (fold into flagship) | Its entire purpose — proving the generic action lifecycle gates a non-inference action — becomes redundant once the flagship demo uses `EconomicAction` for a `paid_api` action natively, which it should under the new framing. Keep the demonstrated scenario, retire the separate script.
| `scripts/demo-cross-provider.ts` | **ARCHIVE** (fold into flagship) | Same reasoning: proving Anthropic+OpenAI dispatch under one task lease is a property the flagship demo should just demonstrate in passing (using both providers across its concurrent workers), not a dedicated script. This is exactly the "repeat the same scripted flow" / "exist only to support old positioning" pattern the brief says to delete.
| `scripts/mcp-smoke-test.ts` | **KEEP** | Real protocol round-trip against a real subprocess — this is infrastructure verification, not product positioning. No redundancy with anything else.
| `scripts/smoke-test-meter.ts`, `scripts/smoke-test-ramp-gateway.ts` | **KEEP** | Real-API verification scripts, infrastructure not positioning. Update field/type names post-rename, logic unchanged.
| `scripts/demo-scenario-output.json` | **DELETE** | Generated artifact from running `demo-scenario.ts`, already stale, not meant to be committed (should have been gitignored — worth adding to `.gitignore` in Phase 1).
| `scripts/port-price-table.mjs` | **KEEP** | Pricing table tooling, orthogonal to the pivot.

### Documentation

| File | Verdict | Why |
|---|---|---|
| `README.md` | **REPLACE** | Leads with exactly the positioning the brief says to stop leading with: "Ramp gives you the policy and the pipe. Scrip is the gate in between," "the gate between Funds and AI Usage Tracking" framing throughout. Also contains stale status claims: "Writes: unit-tested, not yet live-verified" (false — live-verified 2026-07-21), "Not yet built: transactional persistence" (false — CLI has opt-in persistence now), no mention of OpenAI/multi-provider, no mention of the CLI's 5 commands or the approval controller as *built*. Full rewrite required, not incremental.
| `ARCHITECTURE.md` | **GENERALIZE** | Just rewritten this session (commit `d238f40`) to be accurate to the *current* (pre-pivot) system — so it's not stale, but it describes the inference-centric framing the brief wants replaced. Becomes the base to rewrite once Phase 2's domain rename lands, not a discard.
| `LEARNING.md` | **GENERALIZE** | Concepts documented (credential hashing, lease-not-credential-is-the-primitive, attenuated delegation, reserve/commit pattern) are durable and true regardless of the pivot — keep the lessons, update the type names they reference (`InferenceLease` → `ExecutionLease` etc.) as each is renamed.
| `docs/ramp-api-notes.md` | **KEEP** | Purely factual, live-verified API reference (real endpoints, real response shapes, real gotchas). Zero positioning content. No change needed except updating if Ramp's API itself changes.
| `docs/superpowers/specs/2026-07-15-spendspec-mvp-design.md` | **ARCHIVE** | Contains the literal obsolete product name "SpendSpec" the brief explicitly calls out. Historical record of the very first design, genuinely superseded by everything since.
| `docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md` | **ARCHIVE** | Describes `RampApiGateway` as "designed but not yet implemented" — it's been implemented and live-verified since. Superseded by reality; keep for history, not as active documentation.
| `docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md` | **ARCHIVE** | Positioning research doc; useful history of *how* the current Ramp-boundary understanding was reached, but by definition a positioning artifact from before this pivot.
| `docs/superpowers/specs/2026-07-20-enforcement-gap-fixes-design.md` | **KEEP as historical record, content already absorbed** | Describes fixes (onLimit wiring, depth bounding) that are simply how the system works now — no longer a "gap fix," just the architecture. Low priority either way; harmless to archive alongside the others for consistency.
| `docs/superpowers/specs/2026-07-21-approval-controller-design.md` | **KEEP** | Describes a component this pivot brief explicitly wants kept. Still accurate.
| `docs/superpowers/specs/2026-07-21-generic-action-reservation-design.md` | **KEEP, elevate in importance** | This is the design doc for the mechanism the pivot brief thinks needs building (`EconomicAction`) — it already exists. Should be referenced directly in Phase 2 planning, not archived.
| `docs/superpowers/specs/2026-07-21-multi-provider-design.md` | **KEEP** | Describes `ModelProvider`, unaffected by the pivot's positioning concerns (multi-provider support is infrastructure, not a claimed differentiator).
| `docs/superpowers/specs/2026-07-22-cli-design.md`, `2026-07-22-cli-styling-design.md` | **ARCHIVE, superseded by Phase 2 CLI rework** | Describe the flat `scrip status/authorize/delegate/settle/revoke` command shape the brief's new CLI section replaces with a two-level `scrip task ...` / `scrip action ...` structure. Keep for history of why the flat shape was chosen at the time (it was a legitimate, deliberate design), archive once superseded.
| `docs/superpowers/plans/2026-07-15-spendspec-mvp.md` | **ARCHIVE** | Same "SpendSpec" naming issue as its spec.
| `docs/superpowers/plans/2026-07-17-ramp-api-gateway.md` | **ARCHIVE** | Implementation plan for now-completed, now-real work. Historical record only.
| `docs/superpowers/plans/2026-07-22-cli-interface.md` | **ARCHIVE, superseded by Phase 2 CLI rework** | Same reasoning as its spec.
| `.mcp.json`, `.codex/config.toml` (if present) | **KEEP** | Config pointing at `bin/mcp-server.ts` by path — survives regardless of internal renames, no positioning content.

### Config / build

| File | Verdict | Why |
|---|---|---|
| `scrip.yaml` | **GENERALIZE** | Structure survives, gains the `ResourceLimits`/`CapabilityPolicy` fields per §2 above. `cross_provider_demo` budget (added for the multi-provider proof) becomes unnecessary once the flagship demo natively exercises both providers — candidate for removal once Phase 6 lands, not before.
| `package.json` | **GENERALIZE** | `"name": "scrip"` and version survive. `"description"` field doesn't currently exist — worth adding one that reflects new positioning in Phase 1. Script names follow CLI command reshaping in Phase 2.
| `tsconfig.json`, `vitest.config.ts` | **KEEP** | No pivot-related content.

## 4. Proposed final file tree

Following the brief's proposed structure, mapped against what actually
exists today (nothing here is a "cosmetic move with no semantic
benefit" — every move either follows the domain rename or separates a
now-larger `infrastructure/` concern from `domain/`):

```
src/
  domain/
    task-execution.ts        # from lease.ts's TaskExecution/TaskAuthorization types
    execution-lease.ts       # from lease.ts's ExecutionLease/InferenceLease types
    economic-action.ts       # from lease.ts's EconomicAction/ActionReservation types
    task-receipt.ts          # from store.ts's TaskReceipt and usage types
    policies.ts              # new: ResourceLimits, CapabilityPolicy

  application/
    task-authorization-service.ts   # from lease.ts's authorizeTask/delegate
    action-reservation-service.ts   # from lease.ts's reserveAction/commitAction/cancelAction
    task-settlement-service.ts      # from lease.ts's settleTask
    revocation-service.ts           # from lease.ts's revokeTask
    outcome-service.ts              # new: OutcomeVerifier wiring

  infrastructure/
    stores/
      local-store.ts         # from store.ts's LocalReceiptStore
      task-store.ts           # new: interface TaskAuthorizationManager currently implements inline
      # (postgres-store.ts is Phase 3, not Phase 0/1/2)
    providers/
      anthropic-adapter.ts   # from src/providers/anthropic-provider.ts
      openai-adapter.ts      # from src/providers/openai-provider.ts
    ramp/
      ramp-oauth.ts          # unchanged, relocated
      ramp-api-gateway.ts    # unchanged, relocated
      ramp-usage-reporter.ts # from meter.ts

  interfaces/
    cli/
      cli.ts                # from src/cli.ts, command verbs reshaped
    mcp/
      mcp-server.ts          # from src/mcp-server.ts, tool names reshaped
    http/
      # Phase 4, not in this pivot's first cut

  pricing.ts                 # stays at src/ root - orthogonal to domain/application/infra split
  router.ts                  # pending §8 decision
  config.ts                  # stays at src/ root - config loading is neither domain nor infra
  runtime.ts                 # stays at src/ root - composition root
  approval-controller.ts     # stays at src/ root, or moves to application/ - open question

docs/
  archive/
    2026-07-15-spendspec-mvp-design.md
    2026-07-15-spendspec-mvp.md
    2026-07-17-ramp-api-gateway-design.md
    2026-07-17-ramp-api-gateway.md
    2026-07-18-ai-usage-tracking-positioning.md
    2026-07-22-cli-design.md
    2026-07-22-cli-interface.md
    2026-07-22-cli-styling-design.md
  ramp-api-notes.md          # unchanged, active
  PIVOT_AUDIT.md              # this document
  DOMAIN_MODEL.md             # new, Phase 1
  LEDGER_INVARIANTS.md        # new, Phase 1
  RAMP_INTEGRATION.md         # new, Phase 1 (can largely absorb ramp-api-notes.md's content)
  OUTCOME_VERIFICATION.md     # new, Phase 5
  superpowers/
    specs/                    # future specs continue landing here per the brainstorming skill
    plans/
```

## 5. Invariants that must survive — non-negotiable

These are the properties every existing test and every real Ramp/live
run currently proves. Any migration step that can't preserve all of
these, verified by the existing test suite (renamed but logically
unchanged) passing, is a bug, not a design choice:

1. `available = allowance - spent - pending - delegated` — the exact
   reservation arithmetic in `src/lease.ts`. This is the single most
   load-bearing formula in the codebase; 20 of the 93 current tests
   exercise it directly or indirectly.
2. A child's authority can never exceed what its parent has genuinely
   left (attenuation), enforced atomically — concurrent reservations
   against the same parent cannot jointly overspend it.
3. `maxDelegationDepth` is a hard ceiling independent of remaining
   money; the minimum-viable-allowance floor curtails depth further,
   economically.
4. Revoking a task revokes every descendant lease.
5. A reservation above the preauthorized ceiling is rejected and never
   charged to the receipt; provider errors release the reservation.
6. Settlement and revocation both reject while any reservation is
   pending.
7. Credentials are opaque, SHA-256-hashed at rest, compared with
   `timingSafeEqual`, never logged.
8. A denied approval-controller verdict is cached once per task — never
   re-evaluated, never re-billed.
9. A failed Ramp broadcast never blocks or invalidates local
   settlement — the local receipt is the source of truth the instant
   it's written.
10. No test suite call ever hits a real external API — Ramp,
    Anthropic, and OpenAI are always faked in `tests/`; only
    `scripts/smoke-test-*.ts` and the demos touch real services.

## 6. Proposed migration sequence (Phase 1 onward — not started)

This section is planning output only, per the brief's Phase 0
requirement to propose the sequence. Nothing here has been executed.

1. **Phase 1 — rewrite product truth.** New `README.md` leading with
   the approved positioning lines, not the old "gate" framing. Archive
   the 8 docs listed in §3 to `docs/archive/` with the required header.
   Update `LEARNING.md`'s type-name references. Add `package.json`
   `"description"`. This phase touches zero `src/` code — pure doc/positioning
   work, safe to do first and independently verifiable (nothing to test
   except "do the archived docs still resolve if linked, and are they
   clearly marked").
2. **Phase 2 — domain rename + extend.** Rename in `src/lease.ts` and
   `src/store.ts` per §3, in small commits (one type at a time:
   `TaskAuthorization`→`TaskExecution` as its own commit with its own
   green test run, then `InferenceLease`→`ExecutionLease`, then extend
   `EconomicAction`'s fields, then extend the receipt). Compatibility
   wrappers (`reserveRequest` etc.) keep existing call sites compiling
   during the transition. This is the highest-risk phase — see §8.
3. **Phase 3 — durable stores.** Not started in this repo at all today
   (current persistence is the CLI-only opt-in JSON file from this
   session's prior work). Genuinely new work, matches the brief's
   PostgreSQL requirement.
4. **Phase 4 — hosted HTTP API.** Genuinely new surface, doesn't exist
   today in any form.
5. **Phase 5 — outcome verification.** Genuinely new; `TaskReceipt`
   already has an `outcome`/`outcomeEvidence` field to extend, but no
   `OutcomeVerifier` interface or GitHub adapter exists today.
6. **Phase 6 — flagship demo.** Evolve `demo/run-demo.ts` +
   `scripts/demo-scenario.ts` (per §3, don't write from scratch) into
   one scenario proving the full loop including a rejected worker and
   real outcome verification.

## 7. Ramp boundary — current interface vs. proposed `FinanceControlPlane`

`src/store.ts`'s `RampGateway` today:

```ts
interface RampGateway {
  getReportedSpend(rampBudgetId: string, sinceMonth?: string): Promise<number>;
  reportTaskUsage(receipt: TaskReceipt): Promise<void>;
}
```

This is already close to the brief's proposed `FinanceControlPlane` — it's
provider-neutral, async, and exactly matches "Scrip should integrate with
Ramp through adapters, not recreate Ramp." The gap: no `getBudgetPolicy`
(currently a `handlers.ts`-level composition of `getBudget()` +
`getReportedSpend()` + `getBudgetRemaining()`, not one gateway method),
no `getAvailableBudget` as a distinct call (currently folded into
`TaskAuthorizationManager.getBudgetRemaining`), and no
`requestException` (no exception-request flow exists today at all — new
work, not a rename). Renaming `RampGateway`→`FinanceControlPlane` and
consolidating those three methods onto it is a small, low-risk
Phase 2/7 task, not a rewrite — `RampApiGateway` and `MockRampGateway`'s
actual logic doesn't change, only which interface they implement.

## 8. Highest-risk parts of the pivot — flagged for explicit review

1. **`src/lease.ts`'s rename (Phase 2).** 478 lines, 20 direct tests,
   and literally every other module (`proxy.ts`, `approval-controller.ts`,
   `handlers.ts`, `mcp-server.ts`, `cli.ts`, all demos, all scripts)
   imports its types by name. A rename here is a whole-repo-touching
   change even though the logic doesn't move. Recommend the smallest
   possible per-commit slices (see Phase 2 above) specifically because
   of this blast radius, with the full test suite green after every
   single commit, not just at the end.
2. **`BudgetRouter`'s fate is genuinely undecided — needs your call,
   not mine.** The brief offers three options (delete / keep as tiny
   fallback / move behind an adapter) and explicitly says "after
   inspecting actual dependencies." Current dependents: `src/proxy.ts`
   (`ScripClient.run()` calls `this.runtime.router.route()` when no
   explicit model is passed) and 3 tests in `tests/router.test.ts`.
   It's ~20 lines, single-responsibility, has no product marketing
   copy anywhere referring to it as a differentiator today (that
   framing lived only in this session's conversation, not in any
   committed doc) — so the "product theater" concern may not actually
   apply to the code as it exists, only to how it could be *talked
   about*. Recommend: keep it as the tiny fallback-selection helper it
   already structurally is, just don't write any README/positioning
   copy that calls it a wedge. Flagging as a decision point rather than
   deciding unilaterally, since the brief was explicit that this needs
   inspection-then-judgment.
3. **CLI command-shape break.** The 5-command flat CLI (`scrip status`,
   `scrip authorize`, etc.) was built and live-verified in this exact
   session, one turn before this pivot instruction arrived. The pivot
   brief's proposed shape (`scrip task authorize`, `scrip task show`,
   `scrip action reserve`, etc.) is a genuine breaking rework, not an
   extension. Low risk technically (it's the thinnest, most-recently-built
   surface, fully covered by `tests/cli.test.ts`), but worth naming
   explicitly since it means real, recent, working, tested code gets
   restructured almost immediately after being verified live against
   real Ramp.
4. **Scope of Phase 2 vs. "small verified commits."** The brief asks
   for both a deep, wide rename (§3's GENERALIZE rows touch nearly
   every file in `src/`) and small, independently-verified commits.
   Those are in tension: a type rename that must keep 93 tests green
   throughout naturally wants to happen in a few large mechanical
   commits (rename-and-fix-all-call-sites-atomically), while true
   "small verified commits" would mean the repo temporarily has both
   old and new names coexisting via re-exports for several commits.
   Recommend the re-export approach explicitly (e.g. `export type
   TaskExecution = TaskAuthorization` as an interim alias) even though
   it's slightly more ceremony, specifically because it's what makes
   genuinely small, independently-green commits possible here.
5. **Docs claiming things Ramp itself may have changed since
   verification.** `docs/ramp-api-notes.md` and the Ramp-boundary
   sections of `README.md`/`ARCHITECTURE.md` were all live-verified
   against the real sandbox on 2026-07-20/21/22. Nothing in the pivot
   requires re-verifying these, but any *new* Ramp-facing claim written
   during Phase 1's README rewrite should be held to the same standard
   (checked against real docs/API, not written from memory of this
   conversation) rather than assumed to still be current by the time
   Phase 1 actually executes.

## 9. What Phase 0 explicitly does not include

Per the brief's own instruction: no production code edited, no docs
archived yet (only proposed above), no CLI commands changed, no
`BudgetRouter` decision made, no domain types renamed. This document is
the complete Phase 0 deliverable.

## 10. Migration log — what actually happened after Phase 0 review

Given explicit go-ahead to run autonomously ("run until you can no
longer run, implement as much as you can"), work proceeded past Phase 0
through the following, each its own commit with 93→104 tests green
throughout and a clean build after every step:

- **Domain vocabulary (Phase 2, partial):** `TaskExecution`/
  `ExecutionLease`/`EconomicAction`/`FinanceControlPlane` type aliases
  added over the existing types. `ActionReservation`/`EconomicAction`
  extended with a real `status` lifecycle (`reserved`→`committed`/
  `cancelled`, actually transitioned by `commitAction`/`cancelAction`),
  `actionId`, `estimatedCostUsd`, and `metadata`. `TaskReceipt` extended
  with `workerCount`/`actionCount` (aliasing the now-deprecated
  `childAgents`/`requestCount`), a `costs` breakdown computed from
  `actionUsage`, and an optional `evidenceDetail: OutcomeEvidence[]`.
  `ResourceLimits`/`CapabilityPolicy` added to `src/config.ts` as pure
  *derived views* over existing `RampBudgetConfig` fields — no new
  `scrip.yaml` schema, so nothing can silently drift stale.
  **Not done:** the mechanical field-level rename
  (`allowance`→`authorizedUsd` etc.) — staged separately per §8.4, on
  purpose, not an oversight.
- **Outcome verification (Phase 5, first slice):** `OutcomeVerifier`
  interface and a real `GithubPrOutcomeVerifier` (endpoint paths and
  response field names confirmed against GitHub's current REST docs,
  not guessed). Unit-tested with a fake `fetch`; not live-verified (no
  `GITHUB_TOKEN` in this environment).
- **Flagship demo (Phase 6):** `scripts/demo-flagship.ts` added, proving
  the full loop in one deterministic run - concurrent workers, one
  denied by the atomic reservation math, cross-provider dispatch, a
  non-inference paid action, released capacity, real (fake-fetch)
  outcome verification, one settled receipt. `demo-scenario.ts`,
  `demo-generic-action.ts`, and `demo-cross-provider.ts` deleted as
  redundant with it (git history preserves them). Running it live caught
  a real bug: it initially used the `research` budget, which doesn't
  allow the OpenAI model it tried to route to - switched to
  `cross_provider_demo`, which exists for exactly this.
- **Docs (Phase 1):** README fully rewritten with the approved
  positioning and an explicit built/tested-live-verified vs.
  built/tested-not-live-verified vs. designed-not-built status section.
  `ARCHITECTURE.md` and `LEARNING.md` updated in place (not replaced).
  5 of the 8 originally-proposed docs archived to `docs/archive/`
  (SpendSpec-era design/plan, pre-implementation RampGateway
  design/plan, AI-usage-tracking positioning). The other 3 (CLI
  design/plan/styling) were archived and then **un**-archived - see the
  correction note at the top of this document - because the CLI reshape
  they'd be superseded by was never actually built in this pass.

**Explicitly not started (as of the first stopping point):** Phase 3
(Postgres/durable persistence), Phase 4 (hosted HTTP API), the CLI's
task/action command reshape, the full
`src/domain/application/infrastructure/interfaces` directory
restructure, and the `BudgetRouter` decision. Stopped there rather than
starting one of them half-finished.

## 11. Migration log, continued — BudgetRouter decision + CLI reshape

Given explicit direction to close the remaining open items rather than
start Postgres/HTTP API, two more commits landed, tests green
(104→121) throughout:

- **`BudgetRouter` decision closed:** kept as-is (§8.2's recommendation),
  documented directly in `src/router.ts` rather than left as an
  open question - inspecting its real dependents found no
  product-marketing framing anywhere in committed docs calling it a
  differentiator, so the pivot's concern applies to future copy, not to
  deleting working code.
- **CLI reshape done:** `scrip <noun> <verb> ...` replaces the flat
  command list - `budget status`; `task
  authorize|delegate|show|tree|settle|revoke`; `action
  reserve|commit|cancel`; `receipt show|export`. Two new backing
  read capabilities were needed and added first, each with its own
  tests, before the CLI could be built on them:
  `TaskAuthorizationManager.getLeaseTree()` (every lease under a task,
  for `task tree`) and `RampGateway.getReceipt()` (a previously-settled
  receipt by `authorizationId`, implemented against the local write in
  both `MockRampGateway` and `RampApiGateway`, for `receipt
  show`/`receipt export`). `handlers.ts` gained thin wrappers
  (`showTask`, `showTaskTree`, `showReceipt`, `reserveAction`,
  `commitAction`, `cancelAction`) - no new business logic, same pattern
  as every other handler. Verified live against real Ramp across
  separate CLI processes, including both brand-new commands (`task
  tree`, `receipt show`), not just unit-tested.

**Still explicitly not started (as of §11):** the full
`src/domain/application/infrastructure/interfaces` directory
restructure (though `src/infrastructure/postgres/` and
`src/interfaces/http/` were created for the two subsystems below,
following that tree for new code without moving everything else yet).

## 12. Migration log, continued — Phase 3 (Postgres) and Phase 4 (HTTP API)

Given explicit direction to implement the two previously-deferred
subsystems, both landed for real, tests green (129→140) throughout:

- **Phase 3, `PostgresTaskStore`:** a real, project-scoped, ephemeral
  Postgres instance was initialized (`.pgdata-dev/`, gitignored — not a
  system service, doesn't touch any of the user's other Postgres
  installs) specifically so this could be built against and proven live
  rather than mocked. `reserveAction`/`commitAction`/`cancelAction` use
  real transactions with `SELECT ... FOR UPDATE` row locks; idempotency
  keys are supported via a partial unique index. `tests/postgres-task-store.test.ts`
  includes two genuine concurrency-race tests (one within a pool, one
  across two separate `Pool` instances simulating two processes) that
  fire simultaneous reservations exceeding the remaining balance and
  assert exactly one wins — this is the literal claim from the original
  pitch ("two independent processes must not reserve the same remaining
  allowance") now proven, not just designed. **Not wired in** as
  `TaskAuthorizationManager`'s backend — a real, separate integration
  decision (that manager's API is synchronous in several places used
  throughout the whole codebase) deliberately not made unilaterally.
  A real bug was caught building the test: `describe.skipIf()` evaluates
  its condition at collection time, before `beforeAll` runs, so a
  Postgres-availability flag set inside `beforeAll` was always stale —
  fixed with a top-level-await probe instead.
- **Phase 4, hosted HTTP API:** `src/interfaces/http/server.ts` (Express,
  justified as solving routing/body-parsing/error-middleware without
  hand-rolling all of it) wraps the same `handlers.ts` functions the CLI
  and MCP server call. `POST/GET /v1/tasks`, `/v1/tasks/:id/delegate|
  settle|revoke|tree|receipt`, `/v1/actions/reserve`,
  `/v1/actions/:id/commit|cancel`. Real HTTP status codes from real
  error types (401/402/403/404), not generic 500s. Tested with real TCP
  requests against a `server.listen(0)` ephemeral port (11 tests, not
  mocked), then manually smoke-tested with `curl` through a full
  authorize→reserve→commit→settle→receipt lifecycle against real Ramp
  Fund policy.
- **A real, previously-undiscovered bug caught along the way:** the
  compiled production build (`npm run build` → `node dist/bin/http-server.js`)
  had apparently never actually been run before this session — `tsc`
  doesn't copy non-`.ts` assets, so both `model_price.json` (needed by
  `src/pricing.ts`) and the new `schema.sql` were missing from `dist/`,
  and the built server crashed on startup with `ENOENT`. Fixed in the
  `build` script; re-verified by actually running `node dist/bin/http-server.js`
  (not `tsx`) and hitting it with `curl` against real Ramp.
- **Deployment scaffolding:** a multi-stage `Dockerfile` (non-root
  `node` user, added after a real Docker security lint hit during
  review) and `docker-compose.yml` with a real `postgres` service.
  Explicitly documented, not overclaimed: the `Dockerfile` itself was
  never run through `docker build` (no Docker daemon reachable in this
  environment) — every file it references was confirmed to exist, and
  the command it runs was verified directly against the compiled
  output, but the container wrapper is unverified. `docker-compose.yml`'s
  `postgres` service is real but the `app` service doesn't read
  `DATABASE_URL` yet, for the same reason `PostgresTaskStore` isn't
  wired into `TaskAuthorizationManager`.

**What's left, honestly:** wiring `PostgresTaskStore` in as
`TaskAuthorizationManager`'s actual backend (or migrating callers to an
async API that can use it) is the one piece that would make the "durable
persistence" claim end-to-end rather than "proven as a standalone
mechanism." An auth/gateway layer in front of the HTTP API. An actual
`docker build`/deployment. All three are real, scoped, next steps, not
hidden gaps.
