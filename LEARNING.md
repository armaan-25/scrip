# Scrip Learning Notes

## Concepts demonstrated

- A bearer credential proves possession, so it must be short-lived, scoped,
  revocable, and never logged. Scrip hashes credentials with Node's
  `crypto.createHash()` and compares hashes with `timingSafeEqual()`.
- An allowance is not enough for concurrent agents. Pending reservations must
  count against the cap before slow provider requests start, or two valid calls
  can overspend together.
- `max_tokens` provides an output-cost ceiling. Scrip combines it with a
  conservative input ceiling derived from message bytes and the price table, so
  a caller cannot bypass enforcement merely by understating a token estimate.
- Delegation is attenuation: a child credential can have less authority than
  its parent, never more.
- Settlement is task-level. Individual calls become usage events; the durable
  financial artifact is one receipt with actual spend, returned allowance,
  child count, request count, and per-model totals.

## Package responsibilities

- `@anthropic-ai/sdk` performs the provider request and returns token usage.
- `js-yaml` loads human-readable Ramp budget mappings from `scrip.yaml`.
- `@modelcontextprotocol/sdk` and `zod` power the optional MCP adapter and its
  input validation. Neither owns policy or persistence.
- Vitest exercises the lifecycle without making billed API calls.

No new package was added for this pivot; Node's standard `crypto` module is
sufficient for opaque credential generation and hashing.
