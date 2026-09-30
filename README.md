# Scrip

Scrip makes sure an AI agent buys exactly what a person approved, and gets the
money back when it doesn't.

Spending limits, merchant categories, and credentials bound *how much* an agent
can spend and *where*. Every documented agent purchase failure cleared those.
What was wrong was the purchase itself: the right hotel at the right price on
the wrong dates. Scrip binds the payment to the exact purchase.

## How it works, in four steps

1. **The person approves one exact purchase.** Scrip records it (hotel, room,
   dates, price) and computes a fingerprint: a hash that changes if any detail
   changes. The approval is also bound to one registered version of the agent.
2. **The agent gets a card that only fits that purchase.** Single use, one
   merchant, a price ceiling, a time window, and the fingerprint.
3. **The issuer checks the charge.** Wrong merchant, too much money, wrong
   currency, too late, or a second use is declined. If the merchant sends a
   signed order, its fingerprint must match too, so a wrong purchase is
   declined before any money moves.
4. **Scrip checks what was delivered.** The payment and the merchant's
   confirmation are compared with the approval. The agent's own claim of
   success doesn't count. On a mismatch Scrip assembles an evidence packet and,
   where the approved policy allows, asks the merchant for a refund. Money only
   counts as recovered once the refund actually posts.

Nothing here decides who was at fault, and nothing files a dispute.

## Run the demo

Requires Node 24 (`node:sqlite`).

```bash
npm install
npm run demo:protect        # four scenarios in the terminal, ~2 seconds
npm run visuals:protect     # the same run as a page at http://localhost:8798
```

By default everything on the rail side is simulated and labeled so: the card
issuer, the merchants, the confirmation email. No card is issued, no money
moves, no merchant is contacted.

### With live money on Natural

```bash
echo 'NATURAL_API_KEY=your_key' > .env
SCRIP_RAIL=natural npm run demo:protect      # terminal
SCRIP_RAIL=natural npm run visuals:protect   # page; each page load is one live run
npx tsx scripts/natural-verify-live.ts       # read the transfers back (read-only)
```

The card, issuer, and merchants stay simulated; each capture and refund
becomes a real $1.00 transfer between two wallets on the key's account,
tagged with the purchase fingerprint. Details in [docs/natural.md](docs/natural.md).

### The four scenarios

1. **Correct purchase.** The agent buys exactly what was approved at a merchant
   that sends a signed order. Authorized, captured, confirmed, assessed as a
   success from two independent evidence streams.
2. **Violations.** Wrong merchant, amount over the ceiling, wrong currency,
   outside the time window, and a second use of the card. Each is declined
   with one reason. Then the correct charge goes through once.
3. **Same merchant, same price, wrong dates, integrated merchant.** The
   merchant first sends an order with a forged signature (declined), then a
   validly signed order for the wrong dates (declined: fingerprint mismatch).
   Nothing is captured. This is the check the project is about.
4. **Same wrong dates, merchant not integrated.** The issuer sees only
   merchant, amount, currency, and time, so the charge goes through. The
   confirmation email shows the wrong dates, the assessment fails, a recovery
   case opens, a refund is requested, and the receipt shows the money missing
   until the refund posts. It runs twice: 4a is opened by Scrip's detector,
   4b by the person.

## Flight trace demo: what the agent understood, and payments gated on it

```bash
npm run demo:flight                      # offline, instant
SCRIP_RAIL=sandbox npm run demo:flight   # live on Natural's sandbox (fake money)
```

One request ("NYC to SF, Oct 16–18, direct only, refundable, under $600"), three agents:

- **Faithful:** understands correctly, picks the nonstop, pays. Natural holds the payment; Scrip's connector checks the paid-for order's fingerprint against the approved purchase and **approves** it.
- **Misreads:** treats "direct only" and "refundable" as optional. The trace shows exactly what it misunderstood, and its layover pick is **blocked before any payment**.
- **Switches:** approved for the nonstop, but pays for the layover. The connector sees the fingerprint and amount don't match and **denies** the hold; no money moves, and Natural records Scrip's reason.

The live run needs `NATURAL_SANDBOX_API_KEY` and `NATURAL_SANDBOX_AGENT_KEY`. Details in [docs/natural.md](docs/natural.md).

### Real AI agents, per-version track record

```bash
npm run ui                         # page at http://localhost:8799
SCRIP_RAIL=sandbox npm run ui      # same, sandbox selectable
```

Pick "Real AI agent": a real Claude agent (Claude Code CLI, headless, no personal
settings) gets four Scrip tools over MCP (`search_flights`, `state_understanding`,
`request_purchase`, `pay`) and decides on its own what to do. Every tool call,
result, and message is recorded in the trace next to Scrip's checks and Natural's
hold. Each agent version (profile instructions + model) builds a track record:
how often it understood the request, what it misread, what was blocked, what paid.
Try "Vague request" with the bargain agent to see it drop requirements and get
blocked. Needs the `claude` CLI logged in.

Flights come from either the demo catalog or the live web ("Real, from the web"):
the agent researches real flights with web search and page fetches, then submits
the one it picked (airline, flight numbers, times, price, and the page it found
it on) to `request_purchase`. Scrip checks that submission against the confirmed
request and gates the sandbox payment on it. Scrip does not independently verify
web prices or schedules: the flight details are the agent's claim, with the source
page recorded as its evidence. The airline is never paid; Natural's test recipient
stands in.

## Docs

- [How it works](docs/architecture.md): the layers, one purchase end to end,
  where state lives, failure handling, design choices, file map, and limits.
- [Scrip on Natural](docs/natural.md): what runs live on Natural, how the
  adapter works, and what would move into Natural.

## Verify

```bash
npm run build
npx tsc --noEmit
npm test               # offline; no test calls a real API
npm run demo:protect
```

The demo is itself a test: `tests/demo-protect.test.ts` runs it silently and
asserts every scenario's decisions and receipt figures. The live Natural leg
is run by hand and is not part of `npm test`.

