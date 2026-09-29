# Scrip on Natural

What runs live on Natural today, how the adapter works, and what would move
into Natural for the full version.

## What is live and what is simulated

| part | today |
|---|---|
| Approval, fingerprint, agent identity, assessment, recovery | Scrip, real code |
| Card issuance and the issuer gate | Simulated (`SimulatedIssuer`), because Natural has no card product yet |
| Merchants and the confirmation email | Simulated |
| Money: captures and refunds | **Live on Natural**, $1.00 wallet-to-wallet transfers |

## Run it live

```bash
echo 'NATURAL_API_KEY=your_key' > .env
SCRIP_RAIL=natural npm run demo:protect      # terminal
SCRIP_RAIL=natural npm run visuals:protect   # page at http://localhost:8798
npx tsx scripts/natural-verify-live.ts       # read the transfers back (read-only)
```

Both wallets belong to the account behind the key: its default wallet and one
named "Scrip demo: simulated merchant", created on first run. Money never
leaves the account, and each run starts by sweeping the merchant wallet back.
On the page, each load is one live run, and the timeline starts playing only
after the run finishes (about 40 seconds).

Last verified 2026-09-25: 4 captures and 2 refunds, all `COMPLETED`, each
capture tagged with the purchase fingerprint, readable back with
`natural-verify-live.ts`.

## How the adapter works

`src/rails/natural-settlement.ts` wraps the simulated card provider (a
decorator). `issue`, `revoke`, and `requestRecovery` pass straight through;
only `getFacts` changes, turning each simulated capture into a real transfer.
It cannot replace the card provider, because Natural cannot issue or authorize
a card yet; it can only settle.

- **Scale.** The ledger works in "$500 hotel" units so the exact-total rule is
  exercised. The live transfer is $1.00; the real amount and scale are in the
  transfer's tags.
- **Idempotency.** Transfers are keyed `scrip-<operationKey>-capture` and
  `-refund`, so retrying reconciliation cannot pay twice.
- **Refunds count when they post.** `requestRecovery` only records the request.
  A refund fact exists after the reverse transfer completes.
- **Asynchronous transfers.** Natural creates transfers as `PROCESSING`; the
  adapter polls until a terminal status and fails the reconcile on anything
  other than `COMPLETED`.

## Holds and approvals (verified in the sandbox, 2026-09-28)

The flight demo gates real sandbox payments using Natural's own controls:

- A payment over an agent's limit returns normally but **holds** (`IN_REVIEW`); no money moves.
- The **agent cannot approve its own hold** (403). The owner key can approve (`COMPLETED`) or deny (`APPROVAL_DENIED`), and a denial reason is stored on Natural's approval record.
- Tags on payments and payment requests read back in full; holds report the paying agent and why they held.
- Limits must be above zero, so the demo uses a 1-cent agent limit to hold every payment, and restores the previous limit afterwards.
- Tags do not carry from a payment request to the payment that fulfils it; follow the payment's link to the request.
- Observed 2026-09-28: a hold denied **with a reason** shows `denied` on the approval, but the payment record stays `IN_REVIEW` (still true hours later). Denied **without** a reason, the payment moves to `APPROVAL_DENIED`. No money moves in either case. Likely a sandbox quirk worth reporting.

Scrip's connector approves a held payment only if its `scrip_order_fp` tag equals
the approved purchase's fingerprint, the amount is exact, and the paying agent is
the one the purchase was approved for. The fingerprint tag comes from a simulated
seller quote in the demo; in production the seller or Natural would vouch for it.
The connector does not yet check *who* is paid: an agent that tagged the approved
fingerprint and paid the exact amount to a different recipient would pass. Matching
the payee is the next check to add.

## What would move to Natural

1. **The issuer gate.** `authorizeCard()` and `verifyMerchantOrder()` would run
   in Natural's card authorization path.
2. **The card binding.** The purchase fingerprint would be stored with the
   card at issuance, alongside merchant limits.
3. **Signed merchant orders.** Today a shared HMAC key between two simulated
   parties; in production it would come from the merchant side of the rail.

Everything above the payment boundary stays as it is.

Scenario 3 against scenario 4 is the argument. When the merchant sends a
signed order and the issuer checks its fingerprint, the wrong purchase never
reaches Natural. When the issuer checks only merchant, amount, currency, and
time, the money moves and can only be recovered afterwards.
