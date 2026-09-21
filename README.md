# Scrip

Scrip connects what a person authorizes an agent to buy with what the agent
actually pays for and what was delivered.

A person approves one purchase. That approval is bound to a registered agent
version and to the exact purchase, fingerprinted. When the agent pays, the
attempt is checked against that record. Afterward, the payment and the
merchant's confirmation are compared with the same record. If they don't
match, an evidence packet is assembled and, where the approved policy allows,
a refund is requested. Nothing here decides who was at fault, and nothing
files a dispute.

The point is the record, not the agent's judgment. Spending limits, merchant
categories, and credentials bound *how much* an agent can spend. Every
documented agent purchase failure cleared those. What was wrong was the
purchase.

## Run the demo

Requires Node 24 (`node:sqlite`).

```bash
npm install
npm run demo:protect        # four scenarios in the terminal, ~2 seconds
npm run visuals:protect     # same thing as a page at http://localhost:8798
```

Everything on the rail side is simulated and labeled so: the card issuer,
the merchants, the confirmation email. No card is issued, no money moves, no
merchant is contacted.

The four scenarios:

1. **Correct purchase.** The agent buys exactly what was approved at a merchant
   that sends a signed order. Authorized, captured, confirmed, assessed success
   from two independent evidence streams.
2. **Violations.** Wrong merchant, amount over the ceiling, wrong currency,
   outside the time window, and a second use of a single-use card. Each is
   declined by the issuer gate with one reason. Nothing captured.
3. **Same merchant, same price, wrong dates, integrated merchant.** The merchant's
   signed order doesn't match the approved fingerprint. Declined before capture.
   This is the screen the whole project is about.
4. **Same drift, merchant not integrated.** The issuer sees only merchant,
   amount, currency, and time, so the charge goes through. The confirmation
   email arrives with the wrong dates, the assessment fails, a recovery case
   opens with an evidence packet, a refund is requested, and the receipt shows
   "refund pending" and the money still missing until returned funds actually
   post.

### Live money leg on Natural

```bash
cp .env.example .env        # set NATURAL_API_KEY
SCRIP_RAIL=natural npm run demo:protect
```

Natural has no card product yet, so the card and issuer stay simulated. What
runs live is the money fact: each simulated capture becomes a real $1.00
wallet-to-wallet transfer on the account behind the key, tagged with the
purchase fingerprint and operation key, and the ledger records Natural's
transfer id. Refunds are the reverse transfer. Money never leaves the account;
a run starts by sweeping the previous run's balance back. Verified 2026-09-20.
`npx tsx scripts/natural-verify-live.ts` reads the transfers back, read-only.

## What's in the repo

| path | what it owns |
|---|---|
| `src/missions/` | The mission slice: an exact approved contract, its fingerprint, preflight rules, agent identity and version-bound mandates, outcome assessment from evidence the agent did not write, recovery accounting. Append-only event ledger in SQLite. |
| `src/cards/` | The card slice: an issuer-side gate in two tiers (authorization: merchant, amount, currency, window, single use; order: signed merchant order must match the approved fingerprint), a simulated issuer, two simulated merchants. The gate imports nothing from the mission service, registry, or store, and a test enforces that. |
| `src/protect/` | The recovery case: builds the evidence packet and asks the merchant for a refund only where the approved policy allows. |
| `src/rails/` | The live Natural settlement wrapper. |
| `src/lease.ts`, `src/store.ts`, `src/config.ts` | The task ledger underneath: atomic reserve/commit/cancel accounting for one authorized job and its delegated workers, with attenuated delegation and cascading revocation. Predates the purchase work; the mission slice uses it to reserve and settle exposure. |
| `demo/` | `protect.ts` (the demo above) and `deterministic-authorization.ts` (an earlier three-phase version: propose, ratify, enforce, no card). |
| `docs/papers/` | The working paper, with the incident survey, benchmark evidence, related work, and a read-only inspection of Natural's API. |
| `SPEC.md`, `ARCHITECTURE.md`, `LEARNING.md` | Product contract, runtime boundaries and file ownership, concepts and lessons. |

## Verify

```bash
npm run build
npx tsc --noEmit
npm test              # Postgres suite skips without a database
npm run demo:protect
```

## What this does not establish

- That the declared agent software actually ran. Registration is
  self-declared; the manifest digest detects alteration of the record, not of
  the running program.
- That merchant evidence is authentic. A record labeled `source: 'merchant'`
  is only as trustworthy as the adapter that produced it. In the demo the
  "authenticated merchant order" is a shared HMAC key between a simulated
  merchant and a simulated issuer.
- Production payment safety. One category, simulated providers, and a
  one-dollar live leg.

## History

Scrip began as a spend-authorization layer for autonomous work: task
allowances, delegated worker leases, atomic reservations across concurrent
subagents, gated inference, and a Ramp integration for policy and usage
reporting. The ledger from that period is what this repo still settles
through. The Ramp integration, the inference proxy, and the CLI, HTTP, MCP,
Postgres, and Docker surfaces around the ledger were removed on 2026-09-21;
design notes are under `docs/archive/` and the code is in git history.
