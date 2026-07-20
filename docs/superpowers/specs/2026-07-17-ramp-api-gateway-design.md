# Production RampGateway Adapter Design

> **Amendments since this was written** (kept here rather than silently
> rewritten, so the design record stays honest about what was believed at
> the time):
>
> - The project and all its symbols were renamed SpecSpend → Scrip
>   (`SpecSpendClient` → `ScripClient`, `specspend.yaml` → `scrip.yaml`, etc.)
>   — read every code/file reference below with that substitution.
> - **"Limits" was a wrong assumption.** Ramp's real resource for spend
>   policy is the **Funds API**. `ramp_limit_id` below should be
>   `ramp_fund_id` when implemented.
> - **The OAuth token request uses HTTP Basic Auth**
>   (`Authorization: Basic base64(client_id:client_secret)`), confirmed
>   directly from Ramp's own Authorization docs — not the body-based
>   `grant_type=client_credentials` POST described in `RampOAuthClient`
>   below.
> - **The "mocked writes pending Vault approval" framing is superseded.**
>   `ai-usage/unified` is a real, self-serve broadcast-destination API —
>   `reportTaskUsage()` can be a real Ramp write. See
>   [`2026-07-18-ai-usage-tracking-positioning.md`](2026-07-18-ai-usage-tracking-positioning.md)
>   for the corrected read/write design (`RampApiGateway` for reads, a new
>   `Meter` component for writes).

## Goal

Replace the local-only `MockRampGateway` with a real Ramp-backed adapter for
reading budget/spend-limit balances, while being honest that *writing* a
custom "AI task spent $X" event isn't a real Ramp financial record unless it
runs through a Vault-issued virtual card (which needs separate PCI approval
this project doesn't have). Set up the credential plumbing now so real Ramp
API keys can be dropped in before the demo without further code changes.

## Scope: real reads, mocked writes

- `getReportedSpend()` — real OAuth2 client-credentials exchange against
  Ramp's API, reading the actual spend-limit balance for a configured Ramp
  resource ID.
- `reportTaskUsage()` — unchanged from `MockRampGateway`: appends to the
  local JSON receipt store. This is documented as "pending Vault approval,"
  not faked as a real Ramp write.

**Known unknown, called out explicitly:** the exact Ramp Developer API
endpoint path and response field names for reading a spend limit's balance
are not verified in this design — general knowledge of "Ramp has an OAuth
Developer API with a Limits resource" is not the same as a confirmed
request/response shape. `RampApiGateway`'s HTTP-calling internals are
written against `docs/ramp-api-notes.md`, a small reference file the user
fills in from Ramp's own developer documentation before that task is
implemented. The adapter code must not ship with guessed field names typed
in as if they were confirmed.

## Components

### 1. `src/ramp-api-gateway.ts`

```ts
export interface RampApiGatewayConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string; // e.g. https://api.ramp.com or the sandbox base URL
}

export class RampApiGateway implements RampGateway {
  constructor(config: RampApiGatewayConfig, receiptStorePath: string)
  getReportedSpend(rampBudgetId: string, sinceMonth?: string): number
  reportTaskUsage(receipt: TaskReceipt): void
}
```

- Holds a `RampOAuthClient` (below) internally for token acquisition.
- `getReportedSpend()` throws on auth failure or network error — no silent
  fallback to a stale or zero number, since a wrong "remaining budget" is
  the exact failure mode this product exists to prevent.
- `reportTaskUsage()` delegates to the same local-JSON-file logic
  `MockRampGateway` already has (receipt persisted, console-logged) — this
  class does not attempt a live Ramp write.

### 2. `src/ramp-oauth.ts`

```ts
export interface RampOAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export class RampOAuthClient {
  constructor(config: RampOAuthConfig)
  async getAccessToken(): Promise<string>
}
```

- Client-credentials grant (`grant_type=client_credentials`).
- In-memory token cache: reuses the cached token until it's within 60
  seconds of `expires_in`, then re-fetches.
- One HTTP client is injected (not the global `fetch` directly) so tests
  can substitute a fake — same pattern as `SpendSpecClient`'s injected
  `AnthropicLike` client in `src/proxy.ts`.

### 3. Config additions (`src/config.ts`, `specspend.yaml`)

Each budget gains a `ramp_limit_id` field — the real Ramp resource ID for
that budget's spend limit, distinct from the already-present
`ramp_budget_id` (which is currently just an arbitrary label). This field
is optional in the type (`string | undefined`) since the mock gateway
doesn't need it; `RampApiGateway` throws a clear error at construction time
if a budget it's asked about has no `ramp_limit_id` configured.

### 4. Gateway factory (`src/runtime.ts`)

```ts
export function createRampGateway(storePath: string): RampGateway
```

- If `RAMP_CLIENT_ID` and `RAMP_CLIENT_SECRET` env vars are both set,
  constructs `RampApiGateway` (using `RAMP_API_BASE_URL` env var, defaulting
  to a documented sandbox URL placeholder).
- Otherwise constructs `MockRampGateway` and logs which gateway was chosen
  at startup.
- Decided once at process startup, not per-call — behavior shouldn't
  silently flip mid-run.

### 5. `.env.example`

A committed template listing the three env vars
(`RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`, `RAMP_API_BASE_URL`) with comments,
so the user has an obvious place to drop real credentials into a local
`.env` (already gitignored) before the demo.

### 6. `docs/ramp-api-notes.md`

A short reference file with a **known unknowns** section the user fills in
from Ramp's real developer docs (token endpoint path, limits/spend-balance
endpoint path, response field names) before `RampApiGateway`'s HTTP calls
are implemented. If left unfilled when that task comes up, the
implementation step should surface that gap rather than guessing.

## Error handling

- Missing/invalid credentials at startup → `createRampGateway` falls back
  to `MockRampGateway` (this is the "not yet, but before the demo" case) —
  not an error, just a logged choice.
- Credentials present but the OAuth exchange or the balance read fails at
  runtime → `RampApiGateway` throws. This propagates up through
  `TaskAuthorizationManager.getBudgetRemaining()` and fails the calling
  operation loudly rather than authorizing a task against wrong data.

## Testing

- `tests/ramp-oauth.test.ts` — token acquisition and caching logic against
  an injected fake HTTP client (request count assertions to prove caching
  works, expiry-triggered re-fetch).
- `tests/ramp-api-gateway.test.ts` — `getReportedSpend()` parsing against a
  fake HTTP client returning canned responses (once the real response shape
  is confirmed in `docs/ramp-api-notes.md`); error propagation on
  auth/network failure.
- No test hits the real Ramp API — that's a manual, credentials-required
  smoke test, same treatment as `demo/run-demo.ts`.

## Out of scope

- Vault/virtual-card issuance and real `reportTaskUsage()` writes to Ramp.
- Webhooks, accounting metadata sync, reimbursements.
- Multi-entity or multi-workspace Ramp support beyond one `ramp_entity_id`.
