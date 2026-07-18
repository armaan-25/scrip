# SpecSpend Task Credential Design

## Product boundary

SpecSpend converts one Ramp budget into one temporary, enforceable AI-task
allowance. It is not an aggregate spend dashboard, model analytics product,
team attribution layer, broad FinOps platform, or MCP-first system.

## Runtime flow

1. `RampGateway` returns settled spend for a configured Ramp budget.
2. `TaskAuthorizationManager.authorizeTask()` reserves an allowance and returns
   a root `ss_task_…` credential once.
3. The root may call `delegate()` to create child-agent credentials whose caps
   fit inside their parent's unallocated allowance.
4. `SpecSpendClient.run()` derives a conservative input-token ceiling from the
   message bytes, combines it with `max_tokens`, then calls `reserveRequest()`
   with the request's worst-case cost before provider I/O.
5. The manager atomically counts pending reservations against both the lease and
   task allowance, preventing concurrent subagent oversubscription.
6. Actual provider tokens commit against the reservation. Provider failures
   cancel it.
7. `settleTask()` closes the entire lease tree, aggregates per-model usage, and
   sends one `TaskReceipt` to `RampGateway`.

## Trust boundary

- Agents receive only temporary SpecSpend credentials.
- Provider API keys stay in the proxy process.
- Credential hashes, not plaintext credentials, remain in runtime memory.
- The mock gateway stores receipts, never card PAN/CVV data.
- A production Ramp Vault adapter would require Ramp approval and PCI controls.

## Deliberate tradeoff

Task/lease state is in memory for the prototype. This keeps enforcement easy to
trace, but a multi-process production deployment must move authorization,
reservation, idempotency, and expiry state to a transactional data store.
