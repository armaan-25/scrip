# Ramp API notes

Confirmed live against the real sandbox (`https://demo-api.ramp.com`) on
2026-07-20, using this project's actual registered app ("Scrip" in the
Ramp Developer Console). Not guessed — every field below was observed in
a real response.

## OAuth token endpoint

- Full URL: `https://demo-api.ramp.com/developer/v1/token`
  (production equivalent: `https://api.ramp.com/developer/v1/token`)
- Grant type: `client_credentials`
- Auth: **HTTP Basic Auth** — `Authorization: Basic base64(client_id:client_secret)`,
  confirmed working (not the body-based `client_id`/`client_secret` params).
- Request body (`application/x-www-form-urlencoded`):
  `grant_type=client_credentials&scope=funds:read` (space-separated if
  requesting multiple scopes)
- Response (200, confirmed real):
  ```json
  {
    "scope": "funds:read",
    "expires_in": 864000,
    "access_token": "ramp_bus_...",
    "token_type": "Bearer"
  }
  ```
  `expires_in` is in seconds — 864000 = 10 days, matching Ramp's docs for
  client-credentials tokens.
- Auth header for subsequent requests: `Authorization: Bearer <access_token>`.
- **Gotcha, confirmed the hard way:** omitting `scope` from the token
  request body still returns a `200` with a valid-looking token, but that
  token has no scopes and every subsequent API call with it fails with
  `403`. The token response's `scope` field only reflects what you
  explicitly requested — Ramp does not default to "everything this app is
  authorized for." Always send `scope` explicitly.

## Funds endpoint

- List: `GET https://demo-api.ramp.com/developer/v1/funds` — confirmed
  working with the `funds:read` scope, returns `{ "data": [...] }`
- Per-Fund object, confirmed real fields (only the ones relevant to this
  project listed; the real response has more):
  ```json
  {
    "id": "cd1c33eb-d742-4d7e-850f-972eb3c3c53f",
    "display_name": "Software",
    "state": "ACTIVE",
    "balance": {
      "total": { "amount": 0, "currency_code": "USD", "minor_unit_conversion_rate": 100 },
      "cleared": { "amount": 0, "currency_code": "USD", "minor_unit_conversion_rate": 100 },
      "pending": { "amount": 0, "currency_code": "USD", "minor_unit_conversion_rate": 100 }
    },
    "spending_restrictions": {
      "limit": { "amount": 1000000, "currency_code": "USD", "minor_unit_conversion_rate": 100 },
      "interval": "MONTHLY",
      "start_of_interval": "2026-07-01T00:00:00+00:00",
      "next_interval_resets_at": "2026-08-01T00:00:00+00:00"
    }
  }
  ```
- **Amounts are minor units (cents)** — divide by `minor_unit_conversion_rate`
  (always `100` in observed data) to get dollars. `limit.amount: 1000000` = $10,000.
- **`balance.total.amount` semantics — inferred, not explicitly documented:**
  every freshly-seeded demo fund with no transaction history shows
  `balance.total.amount: 0`, while funds with real seeded activity
  (`Client Visits`, `Executive Travel`) show non-zero balances well under
  their limit. This is only consistent with `balance.total.amount` meaning
  **cumulative spend so far this interval**, not remaining headroom — which
  maps directly onto this project's `RampGateway.getReportedSpend()`
  contract with no inversion needed:
  `getReportedSpend() = balance.total.amount / minor_unit_conversion_rate`.
  **Not yet empirically verified by watching a real transaction increase
  it** — recommended next step: use the sandbox's `⌘J` demo actions panel
  ("add transactions") against a test Fund and re-fetch to confirm the
  balance actually increases, before trusting this in a real budget
  decision.
- **`GET /developer/v1/funds/{id}` confirmed working live** (2026-07-20,
  via `scripts/smoke-test-ramp-gateway.ts` against the real "Software" fund)
  — returns the same per-Fund shape as one element of the list response.

## Real Fund IDs available in this sandbox (seeded demo data)

Useful for testing without creating a new Fund:

| Fund | ID | Limit | Interval |
|---|---|---|---|
| Software | `cd1c33eb-d742-4d7e-850f-972eb3c3c53f` | $10,000 | Monthly |
| Software | `695e46a0-8193-4d67-91e3-1c8eb43ec9d9` | $20,000 | Monthly |
| Marketing Ads | `57609773-c915-4aaa-a9c6-c35b1e024a7d` | $15,000 | Monthly |

"Software" is the closest thematic match for an AI/agent spend budget —
`RAMP_RESEARCH_FUND_ID` in `.env` should be set to
`cd1c33eb-d742-4d7e-850f-972eb3c3c53f` for testing.

## AI Usage Tracking (`ai-usage/unified`)

- **Protocol confirmed via Ramp's own internal assistant (2026-07-21):**
  `POST /developer/v1/ai-usage/unified` with the JSON body
  (`schema_version` + `events[]`) is "the designated, provider-neutral
  ingestion path designed specifically for third-party platforms and
  custom integrations." OpenRouter's OTLP-based
  `/developer/v1/ai-usage/openrouter` endpoint is an explicitly
  partner-specific path, "not part of the public developer API surface,"
  not a replacement for `/unified`. No deprecation — `/unified` is the
  standard, supported path for a custom platform like this one.
- **Auth: reusing the same OAuth app, not a separate static key** (also
  confirmed via Ramp's assistant). Add `ai_usage:write` to the same "Scrip"
  app's scopes alongside `funds:read`; the same client-credentials flow
  (`RampOAuthClient`) gets a Bearer token scoped to `ai_usage:write` for
  this endpoint. A separate static API key (Settings → Integrations →
  Connect, or the "API keys" tab on the Developer settings page) also
  works but isn't needed — one OAuth app, two scopes.
- **Live-verified 2026-07-21** via `scripts/smoke-test-meter.ts` — real
  `204`-equivalent success (no error thrown) broadcasting a real
  `TaskReceipt` to the sandbox.
- **Correction, confirmed via a real `400`:** `events[N].usage.meters` is
  **required**, not optional as Ramp's own docs described it ("Additional
  provider-specific dimensions" reads as optional). The real error:
  `{"error_v2":{"fields_validation":{"events.0.usage.meters":"Field required"}}}`.
  `Meter` now always sends `meters: []` when there's nothing
  provider-specific to report.

## Agent Cards (card issuance) - NOT yet live-verified

`RampAgentCardIssuer` (`src/ramp-agent-card.ts`) mints a real single-use
virtual card via what Ramp's published API reference describes as:

- `POST /developer/v1/cards/deferred/virtual`, scope `cards:write` (a
  separate scope/approval from `funds:read`/`ai_usage:write` - confirm it's
  enabled on the "Scrip" app's Developer Console registration before
  testing).
- Async/deferred: the POST returns a task id; the real card (id, last4,
  state) is only available by polling
  `GET /developer/v1/cards/deferred/{task_id}` until it reports success.
- Needs a real cardholder Ramp user (`RAMP_CARDHOLDER_USER_ID`) to issue
  under - unlike Funds/AI Usage Tracking, this isn't just a Fund ID lookup.

**Unlike every other integration in this file, none of this has been
confirmed against a live response yet** - the exact field names
(`spending_restrictions.amount`/`interval`, the deferred-task response
shape) come from Ramp's documentation, not an observed real response.
Run `npx tsx scripts/smoke-test-agent-card.ts` (mints one real $0.01 card
against a `cards:write`-scoped sandbox app) and fix field names against
whatever actually comes back before trusting this in a real purchase flow.

Ramp's own Agent Card product also auto-locks a card to whichever merchant
runs its first real transaction - there's no "lock to merchant X up front"
request field confirmed in the docs, so `CardIssueRequest.merchant` is
recorded on the reservation for our own audit trail only; it is not sent to
Ramp as an enforced restriction.

## Known constraints

- Vault / virtual-card issuance requires separate Ramp approval and PCI
  scopes — out of scope for this adapter.
- Client-credentials tokens work only in the environment (sandbox/prod)
  they were issued in — this app is registered for sandbox
  (`demo-api.ramp.com`), not production.
