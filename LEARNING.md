# Scrip Learning Notes

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

- `@anthropic-ai/sdk` performs the provider request and returns token usage.
- `js-yaml` loads human-readable Ramp budget mappings from `scrip.yaml`.
- `@modelcontextprotocol/sdk` and `zod` power the optional MCP adapter and
  its input validation. Neither owns policy or persistence.
- Vitest exercises the lifecycle without making billed API calls; where a
  scenario needs to be seen rather than just asserted on,
  `scripts/demo-scenario.ts` reproduces it against the real enforcement
  code with a fake Anthropic client — deterministic, free, and honest about
  which parts are real (the reservation math) versus stubbed (the model
  response).

No new package was added for this pivot; Node's standard `crypto` module is
sufficient for opaque credential generation and hashing.
