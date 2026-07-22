# CLI Interface Design

## Goal

Scrip's task lifecycle (check budget status, authorize a task, delegate a
child allowance, settle, revoke) currently only exists as one-off demo
scripts (`scripts/demo-*.ts`, `demo/run-demo.ts`) or as MCP tools for an
agent harness (`src/mcp-server.ts`). There is no way for a human operator
to run these operations directly from a terminal without writing a script
each time. This adds a `scrip` CLI as a third thin surface over the
existing implementation.

## What changes and what doesn't

**Doesn't change:** `src/handlers.ts`, `src/lease.ts`, `src/mcp-server.ts`,
`ScripRuntime`. The CLI calls the exact same handler functions the MCP
server already calls - no new business logic, no duplicated
authorization/settlement code.

**Adds:** `bin/cli.ts` (entry point + argv dispatch), a `scrip` bin entry
in `package.json`, and a `cli` npm script for local dev.

## Commands

All commands construct `ScripRuntime` the same way `bin/mcp-server.ts`
does: load `.env` if present, `new ScripRuntime(process.env.SCRIP_CONFIG ??
'scrip.yaml', process.env.SCRIP_STORE ?? '.scrip/ramp.json')`.

- **`scrip status <budget>`** → `getBudgetPolicy(runtime, budget)`. Prints
  `monthlyLimit`, `reportedSpend`, `availableToAuthorize`,
  `maxTaskAllowance`, `allowedModels`, `fallbackModel`, `onLimit`.

- **`scrip authorize <budget> <taskId> <allowance> <task description...>`**
  → `authorizeTask(runtime, { budget, taskId, task, allowance })`. Prints
  the issued `credential` and `authorizationId`. The task description is
  everything after `<allowance>`, joined back into one string, so it can
  contain spaces without quoting rules tripping people up.

- **`scrip delegate <parentCredential> <agentId> <allowance>`** →
  `delegateTaskAllowance(runtime, { parentCredential, agentId, allowance })`.
  Prints the child `credential`.

- **`scrip settle <authorizationId> [--status success|failure|unknown]
  [--evidence "text"]`** → `settleTask(runtime, authorizationId, outcome?)`.
  Prints the receipt: `actual`, `returned`, `requestCount`, per-model
  usage breakdown, `outcome`.

- **`scrip revoke <authorizationId>`** → `revokeTask(runtime,
  authorizationId)`. Prints a confirmation line. (Not exposed over MCP
  today - the CLI is free to expose more of `handlers.ts` than the MCP
  surface does, since both are thin wrappers over the same functions.)

No `scrip run` (inference) command - running inference belongs in code
(`ScripClient` wrapping a real provider client), not a one-shot CLI call,
per the earlier scoping decision.

## Credential handoff

`authorize`/`delegate` print the credential to stdout; the operator holds
onto it and passes it explicitly to the next command
(`scrip settle <authorizationId>` only needs the authorizationId, not the
credential, per `settleTask`'s existing signature - only `delegate` and a
future `run` would need a credential passed back in). No local session
file, no new secrets-at-rest concern - matches how MCP tool callers
already hold their own credentials today.

## Output and errors

Human-readable text, one labeled field per line - this is an operator
tool for a person to read, not something scripted against, so no JSON
output mode in v1. Any thrown error (unknown budget, `SpendLimitExceededError`,
a real Ramp API failure) is caught once at the top level of `bin/cli.ts`,
printed as `Error: <message>`, and exits with code 1. No new error types -
this only surfaces what `handlers.ts`/`TaskAuthorizationManager` already
throw.

An unknown command or missing required argument prints a one-line usage
summary (`Usage: scrip <status|authorize|delegate|settle|revoke> ...`) to
stderr and exits 1.

## Testing

`tests/cli.test.ts` exercises the dispatch/formatting logic directly
(calling the exported command-handler functions, not spawning a real
subprocess) against a fake `ScripRuntime` built the same way every other
test file builds one: `MockRampGateway` + a temp directory via
`fs.mkdtempSync`. No real Ramp or Anthropic/OpenAI calls in tests, same
policy as everywhere else in this project. Coverage: each of the 5
commands' happy path, plus the unknown-budget and missing-argument error
paths.

## Out of scope

- JSON output mode.
- A `scrip run` inference command.
- Local credential/session persistence between CLI invocations.
- Interactive/REPL mode - each invocation is a single one-shot command.
