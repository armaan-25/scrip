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
- No single-Fund-by-ID endpoint was tried yet (`GET /developer/v1/funds/{id}`
  is assumed to exist and return the same per-Fund shape as one element of
  the list response — standard REST convention, not yet independently
  confirmed).

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

Not yet tested live — no `RAMP_AI_USAGE_API_KEY` available yet. Still
carrying the schema from Ramp's docs (see
`docs/superpowers/specs/2026-07-18-ai-usage-tracking-positioning.md`), not
independently re-verified against a real response. Auth header format for
this endpoint's static API key is assumed `Authorization: Bearer <key>` —
**not yet confirmed**, since it uses a different auth model than the OAuth
flow above and wasn't tested.

## Known constraints

- Vault / virtual-card issuance requires separate Ramp approval and PCI
  scopes — out of scope for this adapter.
- Client-credentials tokens work only in the environment (sandbox/prod)
  they were issued in — this app is registered for sandbox
  (`demo-api.ramp.com`), not production.
