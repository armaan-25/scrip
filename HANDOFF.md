# Handoff: Scrip — deterministic authorization for agentic payments

**Written:** 2026-09-19 (evening). Supersedes the morning handoff. Everything is
committed; the demo exists; the paper is revised; Natural's API has been inspected
read-only. What remains is the cover memo and a decision about sending.

## Read this first

The goal: a **memo to someone at Natural** — here's the gap, the research behind
it, what the structure looks like, how it fits their product, why Armaan is the
person to build it. The paper at `docs/papers/DETERMINISTIC_AGENT_PAYMENTS.md`
(+ `.tex` + `.pdf`) is the attachment. The cover memo itself is **not written**;
the "why me" paragraph in particular is Armaan's to write.

## 2026-09-20: purchase-protection demo built (uncommitted at time of writing)

Codex-shaped brief executed: one flow, approve -> authorize -> verify -> recover,
on the hotel mission, with a SIMULATED issuer gate (two tiers: authorization
and signed-order), two SIMULATED merchants, a recovery case with an evidence
packet, a one-page UI, and a LIVE Natural money leg.

    npm run demo:protect                    # simulated, ~2s
    npm run visuals:protect                 # http://localhost:8798, SSE-fed page
    SCRIP_RAIL=natural npm run demo:protect # LIVE: $1.00 wallet-to-wallet transfers on Natural

Files: src/cards/{types,card-gate,simulated-rail,card-payments}.ts,
src/protect/recovery-case.ts, src/rails/natural-settlement.ts, demo/protect.ts,
visuals/protect-server.ts, visuals/protect.html, scripts/natural-readonly.ts,
tests/{card-gate,simulated-rail,demo-protect}.test.ts, one new event type in
src/missions/types.ts (`recovery_case_opened`). Dependency added:
`@naturalpay/sdk` (official TS SDK; reads NATURAL_API_KEY from env; replaces
hand-rolled fetch against undocumented paths). See ARCHITECTURE.md
"Purchase-protection demo".

**Live rail status: RAN SUCCESSFULLY on 2026-09-20 (Armaan ran it from his
terminal; the harness classifier refuses to move real money).** Seven real
internal transfers on Natural production, all COMPLETED: one sweep
(trf_01a0be0e6fff…, $3.00 stranded by an earlier partial run), four $1.00
captures (trf_…318046, …648530, …9484b3, …5c8d2c), two $1.00 refunds
(trf_…ccd827, …823a6). Balances after: wallet $3.00, simulated-merchant wallet
$2.00 (the two captures without refunds; the next run sweeps them back).

Two things learned from the live run, both worth a line in the memo:
- Internal transfers are asynchronous. They are created PROCESSING and the
  destination wallet's `available` balance does not include them until
  COMPLETED (took a few seconds). The first attempt failed the refund with
  409 insufficient_funds for exactly this reason; the wrapper now polls
  `transfers.get` until terminal before reporting a fact or reversing.
- Wallet names are limited to 32 characters, descriptions to 100.

Run it: `SCRIP_RAIL=natural npm run demo:protect` (needs
`export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"` first in a
fresh shell; the demo loads NATURAL_API_KEY from `.env`). The key in `.env`
is a PRODUCTION party key that Armaan pasted into chat; rotate it after Monday.

Card-slice spec appended to SPEC.md ("# Card slice") was the scoping input;
the build dropped receipt matching and the chargeback stream per the Codex
brief and added the recovery case and the live leg.

## Verification baseline (run 2026-09-19, after the demo landed)

No `.claude/checks.sh` exists. The gate is four commands, all exit 0:

    npm run build
    npx tsc --noEmit
    npm test                   # 253 passed, 8 skipped (Postgres suite needs a DB)
    npm run demo:deterministic # ~2s, no network, temp SQLite deleted on exit

## State of the tree: COMMITTED

Four commits on top of `8ce4e6f` (all local; `main` is now 13 ahead of origin,
nothing pushed):

    97136f0  Add SPEC.md and implementation brief
    200ff6b  Add the purchase mission slice (note: does not build in isolation;
             it imports the identity layer from the next commit — stated in its message)
    5c07c79  Add agent identity with version-bound authority and close four proven exploits
    <next>   Add the deterministic-authorization demo and revise the paper around it

Still untracked and deliberately left alone: `.claude/`, `SKILL.md` (pre-existing,
unrelated).

## What was done this session

**Demo** — `demo/deterministic-authorization.ts`, `npm run demo:deterministic`.
Three phases (PROPOSE → RATIFY → ENFORCE) against in-process fake providers.
The screen that matters is 3a: wrong-date candidate, under cap, permitted merchant,
authenticated agent → `preflight()` refuses; `payments.issue()` calls = 0. Also
shows: untypeable constraint blocking ratification, forged credential rejected,
exact purchase assessed `success` from two sources, paid-but-not-delivered assessed
`failure` with `unrecovered $500` until a refund actually posts.
`runDemo(log)` is exported; `tests/demo-deterministic.test.ts` asserts every outcome.
Architecture note added to `ARCHITECTURE.md` ("Deterministic authorization demo").

**Paper revised** — abstract reframed as the conjunction; §3 leads with
Pass@10 78% → Pass^10 36% (verified in the full text of arXiv:2604.17849: Agent S3 +
GPT-5 on OSWorld); §4.1 Amex indemnification counter-argument (verified against
Amex's own newsroom release — the commitment is *forward-looking and conditional on
the agent sending "authenticated purchase intent"*, which is the artifact we
produce); §5 is now a real related-work section with the four nearest neighbours,
peer-review status, and the four surviving gaps; §8.1 reports the Natural API
inspection; §9.1 describes the demo; appendix names commits and digests.

**Natural API inspected, read-only** (MCP server, agent-scoped OAuth grant; calls:
get_identity, get_party_limits, list_agents, list_transactions, list_customers,
list_external_accounts; plus public docs for create-payment, get-agent, event
catalog). No money moved. Account has zero transactions, so event payloads are
from the published catalog, not observed live. Findings:

| Claim | Answer |
|---|---|
| Can Pay carry an opaque digest? | **Yes, as a passenger.** `tags` (≤30 keys, key ≤128 `[A-Za-z0-9_]`, value ≤256), `description` ≤80, `Idempotency-Key` ≤255, `X-Instance-ID` ≤1024. `tags` is returned on the Payment object and in `payment.completed`. Natural doesn't interpret it → correlation handle, not enforcement point. |
| What's in a mandate beyond limits? | **Nothing about a purchase.** The agent grant is the Agent object: `limits {perTransaction, perDay, perMonth}` in cents + flat permission scopes. Natural's resource literally called `mandate` is an **ACH WEB debit mandate** (`scheme: ach_web`, amountType, frequency, merchantId, `evidence {captureMethod, capturedAt, ipAddress, authorizationText, authorizationUri}`) — evidence of *consent capture*, not outcome. Use the word "mandate" carefully with them. |
| Does the event stream distinguish money moved from thing delivered? | **On the payment leg, no.** Status enum: CREATED, PROCESSING, PENDING_CLAIM, IN_REVIEW, COMPLETED, FAILED, RETURNED, APPROVAL_DENIED, CANCELED — all about money. No fulfillment/delivery event on any resource. `fulfill_payment_request` means *the payer pays* (term collision). The **only** place delivery appears: `chargeback.created` → `reason {category: notReceived, networkCode: 13.1, "Merchandise or services not received"}` — post-hoc, cardholder-raised, card payments only. Claim confirmed with that refinement. |

Correction to the morning handoff: Natural's payment lifecycle is wider than
CREATED/PROCESSING/COMPLETED (see enum above), and the event catalog includes
`mandate.*`, `chargeback.*`, `cardPayment.*`, `refund.*`, `paymentIntent.*`.
`paymentIntent` was **not** inspected and might be the closest thing to a PROPOSE
object — check before claiming anything about it.

## The paper: known remaining issues

- **[38] Busch, German Law Journal 2025** has no title in the reference list.
  Fill it in or drop the citation before circulation.
- **Financial Brand Sept 17 2026 Kathleen Peters piece** ("authorization problem",
  "wrong size") could not be located at a citable URL this session. It is **not
  cited**. The May 1 2026 Financial Brand Amex piece (unbylined) is cited only as
  secondary framing at [35].
- The Asgaonkar escrow citation [36] says "published at IEEE ICBC" without a year;
  arXiv:1806.08379 is the stable pointer.
- The PROPOSE phase in the demo is scripted, not model-driven. The paper says so
  (§9.1, §9.3, §10 "Extraction calibration"). Don't let the memo imply otherwise.

## Research already done — DO NOT REDO

### Natural (verified against ~150 docs pages, 2026-09-18, + API inspection 2026-09-19)
- **Shipped (6):** Wallets, Vaults, Pay, Request, Transfer, Connect.
  **Announced (7):** Voice, Accept, Cards ("Soon"); Charge, Credit, Direct, Billing (Q4 2026).
  Confirmed pricing: Pay 10bps, Request 10bps, Transfer 1.5%. Don't cite other prices.
- **Limits are soft holds, not hard blocks.** A breaching payment returns 2xx, no money
  moves, an approval opens, "an agent can never clear a hold, by design."
  *Program policies* CAN hard-decline (`policy.denied`). So "Natural has no hard
  blocks" is an overreach.
- **Enforcement is server-side**, verbatim: "Permissions and limits are enforced on
  Natural's servers rather than in your code."
- **No agent-to-agent delegation, no budget hierarchy.** Their own memo: "the market
  for agent to agent payments has also not yet materialized."
- **No outcome verification.** "You own the market logic (targeting, sourcing,
  pricing, and fulfillment), and Natural moves each customer's money inside the
  limits they delegated."
- **Hiring: nothing verifiable.** Do not build a pitch around a named role.
- **AUP prohibits building a competing product with their technology.** Evaluating
  and writing about it is fine; wiring Natural in as Scrip's rail is not.
- MCP `list_wallets` refuses agent-attributed calls (least exposure) — acknowledged
  in the paper as a design choice made in the right direction.

### Incident record (thin — this IS the finding)
- **OpenAI Operator, $31.43, Feb 7 2025.** Fowler/WaPo, AIID 1028. Cleanest case.
- **Air Canada tribunal, Feb 2024.** Court ruling; strongest evidence tier.
- **Perplexity, Dec 2 2024.** Paid, never delivered; stale inventory. Single source.
- **Amazon "Buy for Me", Nov 2025–Jan 2026.** 145 brands; merchant absorbed refunds.
- **Replit, July 2025.** NOT a purchase — irreversible-action mechanism only.
- **Prompt injection: payloads yes, victims no.** Unit 42; red-team, never incident.

**Two fabricated claims. DO NOT CITE EITHER:**
- "2.4x agent dispute rate" attributed to rivero.tech — no such stat on the page.
- "CFPB January 2026 advisory on autonomous-agent purchases" — does not exist.

### Benchmarks
- **Pass@10 78% → Pass^10 36%** — arXiv:2604.17849, Gonzalez-Pumariega et al.,
  Agent S3 + GPT-5 on OSWorld. Verified in full text 2026-09-19 (NOT in the abstract).
- **τ-bench** arXiv:2406.12045 — pass^k; retail 61.2% → ~25% at k=8; top error
  category Confirmation Handling. Preprint.
- **"What Is Your AI Agent Buying?"** arXiv:2508.02630, Allouah et al. (Columbia) —
  "model updates can drastically reshuffle market shares."

### Academic literature (~40 papers; abstracts fetched)
**Area 1 (delegated spending authority) is CROWDED.** Nearest neighbours, all
verified 2026-09-19 with titles/authors/dates:
- arXiv:2609.00060 Jiang et al., "A Formal Analysis of Agent Payment Protocols"
  (Tamarin; x402/MPP/ACP/AP2; 40 new issues). Biggest threat; cited.
- arXiv:2603.20953 Uchibeke, "Before the Tool Call: Deterministic Pre-Action
  Authorization for Autonomous AI Agents" (Open Agent Passport).
- arXiv:2607.23586 Zhang & Zhang, "Are You Still the Agent I Authorized? Earned
  Authority under a Fixed Ceiling for Evolving Agents."
- arXiv:2608.23858 Aviv et al., "Beyond the Mandate: A Systematic Security Analysis
  of AP2" — "valid mandate signatures alone do not ensure … reflects the user's intent."

**Only 3 peer-reviewed:** AgentDojo (NeurIPS 2024), Busch (GLJ 2025), Kolt (Notre
Dame L. Rev., forthcoming). CaMeL is a preprint.

**Verified GAPS:** outcome verification for physical goods; agent chargebacks /
authorized-but-not-wanted; UETA §10 applied to LLM agents; real-money failure rates.

**Framing (now in the paper):** novelty is the CONJUNCTION. Each leg has prior art.

### Industry sources
- **Amex, April 14 2026** — newsroom release verified. "In the future, if a Card
  Member authorizes an AI agent … and that agent sends American Express the
  customer's authenticated purchase intent, American Express will protect eligible
  customers from charges related to AI agent error." Forward-looking; conditional.
  Kit components: Agent Registration, Account Enablement, Intent Intelligence,
  Payment Credentials, Cart Context.
- **Instinct** ToS: agent appointment + "no representation or warranty that such
  safeguards will prevent unintended or erroneous Actions"; non-refundable; $100 cap.
  Assistant Benchmark counter-evidence: purchase test passed with approval.

## Next steps, in order

1. **Write the cover memo.** One page. Gap → research → structure → fit (use §8.1's
   three answers verbatim; they were checked against the product) → why Armaan.
   The last part is his. Decide whether the attachment is the PDF or a link.
2. **Fix [38] Busch** citation or drop it.
3. **Optional:** inspect `paymentIntent` in Natural's docs before the memo claims
   anything about what a "propose" object would map to.
4. **Push** when ready — nothing is on origin.
5. Journal MCP was not attached this session; no journal record exists for these
   commits. Record one if it attaches next session.

## Environment

- Node v24.11.0 (`node:sqlite` needs ≥24; prints an ExperimentalWarning, harmless).
- `pandoc` 3.9, `tectonic` 0.17. Rebuild the paper:

      cd docs/papers && pandoc DETERMINISTIC_AGENT_PAYMENTS.md -o DETERMINISTIC_AGENT_PAYMENTS.tex --standalone && tectonic DETERMINISTIC_AGENT_PAYMENTS.tex

- **No browser/computer-use tool attaches.** For blocked sites use
  `curl https://r.jina.ai/<url>` (worked for the Amex newsroom page).
- Natural MCP server attaches in fresh sessions as `mcp__natural__*`; tools are
  deferred — load with ToolSearch `select:mcp__natural__get_identity,...`.
  Always pass `instanceId`. Read-only calls that worked: get_identity,
  get_party_limits, list_agents, list_transactions, list_customers,
  list_external_accounts. `list_wallets` refuses agent-attributed calls.
