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
