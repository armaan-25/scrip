# Scrip Architecture

## Runtime boundaries

### Ramp policy and reporting

`src/store.ts` defines `RampGateway`. `MockRampGateway` is the local adapter: it
reads settled usage and persists final task receipts. A production adapter can
replace it without changing enforcement.

### Authorization domain

`src/lease.ts` owns `TaskAuthorizationManager`, task authorizations, hierarchical
inference leases, bearer credential hashing, in-flight request reservations,
revocation, and settlement aggregation. This state currently lives in the Node
process.

### Provider enforcement

`src/proxy.ts` owns `ScripClient`. It selects an allowed model, derives a
conservative input-token ceiling from the message bytes, reserves the maximum
possible request cost, calls Anthropic, and commits real token usage.
Provider keys live in this process and never flow to agents.

### Interfaces

`src/handlers.ts` exposes transport-independent task operations.
`src/mcp-server.ts` wraps those operations for MCP-capable agents. MCP is an
adapter, not the state or enforcement layer.

## End-to-end flow

```text
Caller selects budget + task allowance
→ TaskAuthorizationManager validates Ramp policy and reserves allowance
→ root agent receives a temporary credential
→ root delegates smaller credentials to child agents
→ ScripClient computes the provider request ceiling
→ TaskAuthorizationManager reserves it against lease + task
→ Anthropic request executes
→ actual tokens replace the pending reservation
→ settleTask closes every lease and aggregates one receipt
→ RampGateway reports task usage back to the Ramp boundary
```

## Failure propagation

- Invalid, expired, settled, or revoked credentials fail before provider I/O.
- Disallowed models and unaffordable request ceilings fail before provider I/O.
- Provider errors release pending reservations and propagate to the caller.
- Settlement rejects while a request is in flight.
- A provider response above its preauthorized ceiling is rejected and not
  charged to the task receipt.

## Production gaps

The next durable boundary is transactional persistence for authorizations and
reservations, with idempotency keys and expiry cleanup. Real Ramp OAuth/funds,
webhooks, accounting metadata updates, and Vault access require a production
adapter and the appropriate Ramp approval/scopes.
