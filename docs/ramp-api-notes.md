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

## Card issuance - Vault API cards vs. real Agent Cards

`RampAgentCardIssuer` (`src/ramp-agent-card.ts`) mints a real single-use
Ramp card, but **not through Ramp's actual Agent Cards product** - that
distinction took three real, live-verified rounds to nail down, in order:

**Round 1 - the endpoint didn't exist.** The original implementation called
`POST /developer/v1/cards/deferred/virtual`, guessed from docs prose
describing an "async, deferred" card-creation flow. Live testing got a real
`403` naming a scope (`cards:write`) that isn't in Ramp's real scope list at
all - which led to fetching Ramp's actual OpenAPI spec
(`docs.ramp.com/openapi/developer-api.json`) directly and searching it for
every path containing "card" or "deferred". **No `/cards/deferred/*` path
exists anywhere in the real API.** The whole endpoint was fabricated from
documentation prose, never verified against the spec.

**Round 2 - the real endpoint, wrong product.** The spec's actual card-vault
path is `POST /developer/v1/cards/vault` (`cards:read_vault` +
`limits:write` scopes), synchronous - a single `201` returns the full card
(`pan`/`cvv`/`expiration`) directly, no polling. Rewrote against this and
confirmed the token genuinely carries both scopes (Ramp's OAuth silently
drops scopes an app isn't approved for - checked the token response's own
`scope` field directly, not assumed). Every request still gets the same
invariant `400 DEVELOPER_7098`, `"It's possible you are using the incorrect
base URL for this request"` - identical whether the request body is fully
populated or stripped to the one field the schema actually requires. A real
scope-mismatch error looks different on this API (`403 DEVELOPER_7100`,
names the missing scope explicitly - confirmed by deliberately calling an
endpoint this token doesn't have permission for). That comparison is what
rules out "we're sending something wrong" as the explanation.

**Round 3 - the real reason.** `docs.ramp.com/developer-api/v1/
build-for-ai-agents` draws the line explicitly: *"Virtual cards — non-agent
virtual cards (Vault API or embedded iframe) for human-driven flows"* is a
separate product from Agent Cards. Real Agent Card issuance
(`ramp_get_agent_card_creds` over MCP, or the CLI's `agentic-purchase`
skill) is built on `https://api.ramp.com/agent-tools`, which the same page
states plainly: *"These endpoints are not accessible to external clients."*
**There is no direct client-credentials REST call any third-party app can
make to mint a real Agent Card - not a missing scope, not a wrong URL, an
architectural boundary.** Separately, Ramp's changelog (Feb 10 2026) also
describes `/cards/vault` itself as gated to "vault API access holders," a
business-level PCI-qualification entitlement above the OAuth scope layer -
which is the more immediate reason the live calls above still 400. A
support ticket referencing the exact error id/code is filed.

**What this means for `RampAgentCardIssuer` going forward:** it's kept as a
real integration against Ramp's real Vault API - same "single-use payment
instrument capped at a reservation" shape `reserveCardPurchase()` needs -
but it will never produce an actual Agent Card. A real Agent Card
integration needs a genuinely different shape: either Scrip shelling out to
the real `ramp-cli` binary as a subprocess, or Scrip acting as an MCP client
against `https://mcp.ramp.com/mcp`. Neither is built. Run
`npx tsx scripts/smoke-test-agent-card.ts` to re-check current live status
against `/cards/vault` once the support ticket resolves.

`CardIssueRequest.merchant` is recorded on the reservation for this
project's own audit trail only - not confirmed whether the Vault API's
`spending_restrictions` accepts an upfront merchant/vendor restriction
(its request schema exposes `allowed_categories`, not an explicit merchant
field, as far as this research went).

## Known constraints

- Vault / virtual-card issuance requires separate Ramp approval and PCI
  scopes — out of scope for this adapter.
- Client-credentials tokens work only in the environment (sandbox/prod)
  they were issued in — this app is registered for sandbox
  (`demo-api.ramp.com`), not production.
