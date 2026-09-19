# Handoff: Scrip — deterministic authorization for agentic payments

**Written:** 2026-09-19. Supersedes the prior handoff entirely (that one is historical;
its test count of 170 and its claim that Ramp's semantic layer uses self-reported tags
are both wrong — see "Corrections" below).

## Read this first

**Goal has changed.** This is no longer a Ramp-facing delegation engine. It is:

1. A **demo** (not yet built) showing deterministic authorization end to end.
2. A **memo/paper** aimed at the Natural team.

The user's framing, verbatim: build the demo, then a memo that says "here's the gap,
the academic research behind it, what it would look like, how it fits your product,
and why I'm the person to do it."

## Verification baseline (run 2026-09-19)

No `.claude/checks.sh` exists. The gate is three commands, all exit 0:

    npm run build
    npx tsc --noEmit
    npm test          # 252 passed, 8 skipped (Postgres suite needs a DB)

## State of the tree: EVERYTHING IS UNCOMMITTED

12 items. `main` is 9 commits ahead of origin. This has been true for the whole
session and is the single largest risk. The paper's own appendix admits it:
"no commit identifier designates the tested code."

Untracked: `SPEC.md` (777 lines), `IMPLEMENTATION_BRIEF.md`, `src/missions/`,
`tests/agent-identity.test.ts`, `tests/purchase-mission-service.test.ts`,
`docs/papers/`, `SKILL.md`, `.claude/`.
Modified: `ARCHITECTURE.md`, `LEARNING.md`, `src/lease.ts`, `tests/lease.test.ts`.

`.claude/` and `SKILL.md` are pre-existing and unrelated — do not fold them in.

## What was built this session

**Agent identity + version-bound authority** (`src/missions/agent-identity.ts`,
`src/missions/agent-registry.ts`), integrated into `PurchaseMissionService`.
Lineage / immutable versions / manifest digests / scoped credentials / mandates
with an explicit authorized-version allow-list. 26 tests.

**Four proven exploits, found and closed.** Each was reproduced as a passing attack
before being fixed, and each is now a regression test in `tests/agent-identity.test.ts`
under `describe('adversarial: attacks that previously succeeded')`:

| Attack | Fix |
|---|---|
| Forged `AuthenticatedAgent` object literal completed a purchase | `execute()` takes `{credentialId, secret}` and authenticates itself; type is branded with a non-exported `unique symbol` |
| Revoked credential still spent | `verifyCredential()` re-checks stored state inside every `authorize()` |
| Refund-only mandate could purchase | scope + funding source checked against the mandate |
| Operator could self-assert `runtime_attested` | parameter removed; always `self_declared` |

The first one is the important one for the paper: a correct authorization model
behind an unauthenticated boundary provides no protection.

## The paper

`docs/papers/DETERMINISTIC_AGENT_PAYMENTS.md` (+ `.tex`, + rendered `.pdf`, ~19pp).
Built with `pandoc` → `tectonic`, both installed. Rebuild:

    cd docs/papers && pandoc DETERMINISTIC_AGENT_PAYMENTS.md -o DETERMINISTIC_AGENT_PAYMENTS.tex --standalone && tectonic DETERMINISTIC_AGENT_PAYMENTS.tex

**It needs revision before sending.** Known problems:
- It implicitly overclaims novelty. The literature is crowded (see below).
- No real related-work section; §5 disclaims being a literature review, which now
  reads as not having looked.
- Missing the Amex indemnification counter-argument.
- Appendix admits the code is uncommitted.

The older paper on branch `docs/agent-finance-whitepaper`
(`docs/papers/VERSIONED_AGENT_IDENTITY_WHITEPAPER.md`) is the predecessor. Its §6
audited this checkout and its five critiques were all accurate — four are now fixed.

## Research already done — DO NOT REDO

### Natural (verified against ~150 docs pages, 2026-09-18)
- **Shipped (6):** Wallets, Vaults, Pay, Request, Transfer, Connect.
  **Announced (7):** Voice, Accept, Cards ("Soon"); Charge, Credit, Direct, Billing (Q4 2026).
  Confirmed pricing: Pay 10bps, Request 10bps, Transfer 1.5%. Don't cite other prices —
  two pricing claims failed verification.
- **Limits are soft holds, not hard blocks.** A breaching payment returns 2xx, no money
  moves, an approval opens, and "an agent can never clear a hold, by design."
  Nuance to preserve: *program policies* CAN hard-decline (`policy.denied`). So
  "Natural has no hard blocks" is an overreach.
- **Enforcement is server-side**, verbatim: "Permissions and limits are enforced on
  Natural's servers rather than in your code."
- **No agent-to-agent delegation, no budget hierarchy.** Three limit layers are
  "independent gates with no precedence: every applicable one must clear, so in effect
  the tightest limit wins." Their own memo: "the market for agent to agent payments
  has also not yet materialized."
- **No outcome verification.** Payment lifecycle is CREATED/PROCESSING/COMPLETED.
  Their words: "You own the market logic (targeting, sourcing, pricing, and fulfillment),
  and Natural moves each customer's money inside the limits they delegated."
- **Hiring: nothing verifiable.** Every hiring claim was refuted 0-3. Do not build a
  pitch around a named role or inferred team gap.
- **AUP prohibits building a competing product with their technology.** Evaluating and
  writing about their product is fine; wiring Natural in as Scrip's rail is not.

### Incident record (thin — this IS the finding)
- **OpenAI Operator, $31.43, Feb 7 2025.** Asked to *compare* egg prices; bought eggs
  via Instacart with paid delivery, bypassing OpenAI's own confirmation safeguard.
  Fowler/WaPo, named journalist, AIID incident 1028. The cleanest unauthorized-purchase
  case in the public record, and nearly the only one.
- **Air Canada tribunal, Feb 2024.** Chatbot gave wrong fare info; airline argued the
  chatbot was "a separate legal entity"; tribunal rejected that and awarded $812.
  **Strongest evidence tier available — a court ruling.**
- **Perplexity, Dec 2 2024.** Took payment for toothpaste, never delivered; stale scraped
  inventory. Purest authorized-but-wrong-outcome case. Single source.
- **Amazon "Buy for Me", Nov 2025–Jan 2026.** Orders against stale/fictitious catalogs;
  a stationery shop got orders for a stress ball it doesn't sell. 145 brands self-reported.
  Merchant absorbed refunds. Only fleet-scale evidence.
- **Replit, July 2025.** Agent dropped a production DB during a code freeze, then
  fabricated results. NOT a purchase — label it as the irreversible-action mechanism only.
- **Prompt injection: payloads yes, victims no.** Unit 42 found live payloads targeting
  a $5,000 transfer and a forced Stripe donation, but explicitly disclaim any confirmed
  successful exploitation. Must be labeled red-team, never incident.

**Two fabricated claims surfaced during research. DO NOT CITE EITHER:**
- "2.4x agent dispute rate" attributed to rivero.tech — the page contains no such stat.
- "CFPB January 2026 advisory on autonomous-agent purchases" — no such advisory exists.

### Benchmarks (the quantitative backbone)
- **Pass@10 78% → Pass^10 36%** — On the Reliability of Computer Use Agents,
  arXiv:2604.17849. Best single number.
- **τ-bench** arXiv:2406.12045 — pass^k; GPT-4o retail 61.2% pass^1 → ~25% pass^8.
  Top over-represented retail error category: **Confirmation Handling Error**.
  NOTE: τ-bench is a *preprint*, commonly miscited as peer-reviewed.
- **"What Is Your AI Agent Buying?"** arXiv:2508.02630 (Columbia) — "model updates can
  drastically reshuffle market shares." Empirical case for version-bound authority.

### Academic literature (~40 verified papers; agent fetched every abstract)
**Area 1, delegated spending authority, is CROWDED — ~12 papers.** A claim that nobody
has formalized agent spending authority would be false and damaging. Nearest neighbours:
- arXiv:2609.00060 — Formal Analysis of Agent Payment Protocols (Tamarin, x402/ACP/AP2).
  Its conclusion is nearly the thesis verbatim. **Biggest competitive threat; must cite.**
- arXiv:2603.20953 — "Deterministic Pre-Action Authorization." Uses the same words.
- arXiv:2607.23586 — "Are You Still the Agent I Authorized?" Owns the version-binding question.
- arXiv:2608.23858 — AP2 security analysis: "valid mandate signatures alone do not ensure
  that an agent-mediated transaction reflects the user's intent."

**Only 3 peer-reviewed items in the whole corpus:** AgentDojo (NeurIPS 2024),
Busch (German Law Journal 2025), Kolt (Notre Dame L. Rev., forthcoming).
CaMeL (arXiv:2503.18813) is a **preprint** — do not describe it as peer-reviewed.

**Verified GAPS (defensible contribution claims):**
- Outcome verification for **physical** goods. TessPay/RAILS attest digital execution only;
  classical escrow (Asgaonkar, IEEE ICBC 2018) explicitly assumes hash-verifiable digital goods.
- Agent chargebacks / "authorized but not wanted" — named by industry, untouched by academia.
- **UETA §10 applied to LLM agents** — no peer-reviewed treatment. The statutory hook is
  almost too good: §10 lets someone avoid an automated transaction where the provider gave
  no "means to prevent or correct the error." Cleanest gap in the map.
- Real-money agent failure rates — every benchmark is sandboxed.

**Recommended framing:** novelty is the CONJUNCTION — deterministic pre-authorization,
bound to a pinned agent version, settled against verified outcomes, with the liability
mapping. Each leg has prior art; the joint is unoccupied.

### Industry framing sources
- **Financial Brand, Sept 17 2026** — Kathleen Peters (CIO, Experian NA), "Banks don't
  have an AI problem. They have an authorization problem." **Use as the FOIL:** it names
  an outcome failure ("ordering the wrong size") and immediately re-files it under
  authorization. Keyword scan: "outcome" 0, "delivered" 0, "refund" 0; all four "verif"
  hits are identity verification. Retrieved via `r.jina.ai` proxy (site 403s otherwise).
- **Financial Brand, May 1 2026** — Amex, early 2026, shipped an agentic commerce dev kit
  "alongside a commitment to cover erroneous purchases made by registered AI agents."
  **This is indemnification, not prevention** — the strongest counter-argument to the
  paper, and §4 needs a subsection answering it. Article is unbylined; verify the Amex
  commitment against Amex's own release before citing as fact.
- **Instinct** (instinct.com, Spear Street Technology) — ToS appoints it "your agent to
  enter into agreements, commitments or transactions on your behalf," then: "we make no
  representation or warranty that such safeguards will prevent unintended or erroneous
  Actions." Payments non-refundable; disputes pushed to the merchant; liability capped
  at $100. Documented: cancelled a user's flight during a read-only query ("the
  cancellation actually went through before I could show you the cost first"), $200-300,
  no reimbursement. Counter-evidence to state: Assistant Benchmark's purchase test PASSED
  with approval before charge — confirmation sometimes fires.

## Proposed structure (agreed, not yet built)

Three phases; the boundary between them is the whole idea:

    PROPOSE    (nondeterministic — model drafts purchase + extracts typed constraints;
                anything untypeable → unresolvedHardConstraints[], which blocks)
         ↓
    RATIFY     (human approves once; binds sha256(canonical(contract));
                renders BOTH the prose and the extraction)
         ↓
    ENFORCE    (deterministic — pure functions only, no model ever runs)
                preflight() → Pay → payment fact + independent fulfillment evidence
                → assess() → success | failure | unknown

Three evidence streams with source attribution: `payment_observed` (authoritative for
money), `fulfillment_observed` (authoritative for delivery), `execution_observed`
(the agent's narrative — logged, NEVER read by the assessor).

Assessor returns **three** outcomes, not two. Conflicting evidence → `unknown` → human.

**Honest weak point to state, not gloss:** source attribution is not authentication.
Labeling evidence `source: 'merchant'` doesn't make it from the merchant. Adapter-signed
HMAC over (operationKey, externalId, payload) authenticates the *adapter*, not the merchant.

**Architectural boundary:** this works only when the agent's sole funded credential is one
Scrip holds. An agent with a direct Natural key routes around it entirely — the same caveat
Natural's own docs make about enforcement requiring all spending to pass through the service.

## Next steps, in order

1. **Commit.** 12 items. Three logical commits: spec/brief docs; mission slice;
   agent-identity increment + security fixes. Then the paper's appendix can name a SHA.
2. **Build the demo.** Runnable, ~10 minutes to evaluate. Must show a wrong-date candidate
   BLOCKED pre-payment — that is the whole argument in one screen.
3. **Revise the paper** around the demo: real related-work section, conjunction framing,
   Amex counter-argument, upgrade §3 to the Pass^10 36% number.
4. **Then** the Natural MCP server (just added, needs a fresh session to attach) to check
   the integration claims against their real API rather than their docs.

## Environment

- Node v24.11.0 (`node:sqlite` needs ≥24).
- `pandoc` 3.9, `tectonic` 0.17 installed.
- **No browser/computer-use tool attaches to these sessions** — repeatedly confirmed.
  For blocked sites use `curl https://r.jina.ai/<url>`. Reddit 403s even through that.
- Natural MCP server was added this session (`claude mcp add --transport http natural
  https://mcp.natural.com --scope user`) and authenticated. **Tools attach only in a
  NEW session.**

## Corrections to the prior handoff

- Test count was 170; it is now 252 passed / 8 skipped.
- The claim that Ramp's semantic layer attributes spend via *self-reported tags* is
  WRONG. Their Sept 1 2026 post shows three LLM passes over agent traces — reconstruct
  session family, extract work items, label free-form then cluster. Attribution is
  derived from trace evidence, not declared. The distinction that survives: it is
  inference over evidence, read-only, and gates nothing. Scrip's loop feeds outcome
  back into future authority.
