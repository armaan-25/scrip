# CLI Interface Implementation Plan

> **Still describes the current CLI as of this pivot** - see the note in
> `docs/superpowers/specs/2026-07-22-cli-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scrip` CLI that lets a human operator run the existing task lifecycle (status, authorize, delegate, settle, revoke) from a terminal, as a thin third surface over `src/handlers.ts` alongside the MCP server and demo scripts.

**Architecture:** Mirrors the existing `src/mcp-server.ts` / `bin/mcp-server.ts` split: a testable `src/cli.ts` module exports `runCli(runtime, argv)` (pure — takes parsed input, returns a formatted string, throws on error, touches no I/O), and a thin `bin/cli.ts` bootstrap loads `.env`, constructs `ScripRuntime` the same way `bin/mcp-server.ts` does, calls `runCli`, and handles process exit codes/stdout/stderr.

**Tech Stack:** TypeScript/Node, `tsx` for direct execution (no build step required to run), Vitest for tests. No new dependencies — hand-rolled `argv` parsing, per the approved design.

## Global Constraints

- No new npm dependencies (spec: "Hand-rolled argv parsing (Recommended)... no new dependency").
- No JSON output mode in v1 — human-readable text only (spec: "Output and errors").
- No local credential/session persistence between invocations (spec: "Credential handoff").
- No `scrip run` inference command (spec: "Out of scope").
- Tests use `MockRampGateway` + a temp directory, never real Ramp/Anthropic/OpenAI calls (spec: "Testing").
- `runCli` calls only the existing exported functions in `src/handlers.ts` — no new business logic (spec: "Doesn't change").

---

### Task 1: `runCli` core with the `status` command

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `getBudgetPolicy(runtime: ScripRuntime, budgetName: string)` from `src/handlers.ts` (returns `{ rampBudgetId, monthlyLimit, reportedSpend, availableToAuthorize, maxTaskAllowance, allowedModels, fallbackModel, onLimit }`); `ScripRuntime` from `src/runtime.ts`; `MockRampGateway` from `src/store.ts`.
- Produces: `export class UsageError extends Error {}` (thrown for bad/missing arguments — `bin/cli.ts` in Task 6 prints its message without an `Error:` prefix); `export async function runCli(runtime: ScripRuntime, argv: string[]): Promise<string>` — the only entry point every later task extends by adding a new `case` branch.

- [ ] **Step 1: Write the failing test**

Create `tests/cli.test.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, UsageError } from '../src/cli.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let runtime: ScripRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-cli-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('runCli status', () => {
  it('prints budget policy fields for a known budget', async () => {
    const output = await runCli(runtime, ['status', 'research']);
    expect(output).toContain('rampBudgetId: ramp-budget-research');
    expect(output).toContain('monthlyLimit: $100.0000');
    expect(output).toContain('reportedSpend: $0.0000');
    expect(output).toContain('availableToAuthorize: $100.0000');
    expect(output).toContain('maxTaskAllowance: $10.0000');
    expect(output).toContain('allowedModels: claude-sonnet-5, claude-haiku-4-5-20251001');
    expect(output).toContain('fallbackModel: claude-haiku-4-5-20251001');
    expect(output).toContain('onLimit: deny');
  });

  it('throws for an unknown budget', async () => {
    await expect(runCli(runtime, ['status', 'not-a-real-budget'])).rejects.toThrow(/Unknown Ramp budget/);
  });

  it('throws a UsageError when the budget argument is missing', async () => {
    await expect(runCli(runtime, ['status'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError for an unknown command', async () => {
    await expect(runCli(runtime, ['not-a-command'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when no command is given', async () => {
    await expect(runCli(runtime, [])).rejects.toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/cli.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/cli.ts`:

```typescript
import { getBudgetPolicy } from './handlers.js';
import type { ScripRuntime } from './runtime.js';

export class UsageError extends Error {}

const USAGE = 'Usage: scrip <status|authorize|delegate|settle|revoke> ...';

export async function runCli(runtime: ScripRuntime, argv: string[]): Promise<string> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'status':
      return runStatus(runtime, rest);
    default:
      throw new UsageError(USAGE);
  }
}

async function runStatus(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [budget] = args;
  if (!budget) throw new UsageError('Usage: scrip status <budget>');

  const policy = await getBudgetPolicy(runtime, budget);
  return [
    `rampBudgetId: ${policy.rampBudgetId}`,
    `monthlyLimit: $${policy.monthlyLimit.toFixed(4)}`,
    `reportedSpend: $${policy.reportedSpend.toFixed(4)}`,
    `availableToAuthorize: $${policy.availableToAuthorize.toFixed(4)}`,
    `maxTaskAllowance: $${policy.maxTaskAllowance.toFixed(4)}`,
    `allowedModels: ${policy.allowedModels.join(', ')}`,
    `fallbackModel: ${policy.fallbackModel}`,
    `onLimit: ${policy.onLimit}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Add runCli core with the status command"
```

---

### Task 2: `authorize` command

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `authorizeTask(runtime, { budget, taskId, task, allowance }): Promise<IssuedTaskAuthorization>` from `src/handlers.ts`, where `IssuedTaskAuthorization = { authorization: TaskAuthorization, lease: InferenceLease, credential: string }` (from `src/lease.ts`); `runCli`/`UsageError` from Task 1.
- Produces: nothing new consumed by later tasks (each command is independent), but establishes the pattern (`case 'authorize': return runAuthorize(runtime, rest);`) Tasks 3-5 repeat.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts` (new `describe` block after the existing one):

```typescript
describe('runCli authorize', () => {
  it('authorizes a task and prints the credential and authorizationId', async () => {
    const output = await runCli(runtime, [
      'authorize',
      'research',
      'task-1',
      '2',
      'Review',
      'authentication',
      'code',
    ]);
    expect(output).toContain('credential: scrip_');
    expect(output).toMatch(/authorizationId: [0-9a-f-]{36}/);
    expect(output).toContain('allowance: $2.0000');
    expect(output).toContain('task: Review authentication code');
  });

  it('throws a UsageError when fewer than 4 arguments are given', async () => {
    await expect(runCli(runtime, ['authorize', 'research', 'task-1', '2'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when the allowance is not a number', async () => {
    await expect(
      runCli(runtime, ['authorize', 'research', 'task-1', 'not-a-number', 'Review code'])
    ).rejects.toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — output does not contain `'credential: scrip_'` (unknown command falls through to `UsageError`, so the first assertion throws instead of matching).

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add the `authorize` case to the `switch` in `runCli`:

```typescript
    case 'authorize':
      return runAuthorize(runtime, rest);
```

Add the import and the handler function:

```typescript
import { authorizeTask, getBudgetPolicy } from './handlers.js';
```

```typescript
async function runAuthorize(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [budget, taskId, allowanceArg, ...taskWords] = args;
  if (!budget || !taskId || !allowanceArg || taskWords.length === 0) {
    throw new UsageError('Usage: scrip authorize <budget> <taskId> <allowance> <task description...>');
  }
  const allowance = Number(allowanceArg);
  if (Number.isNaN(allowance)) {
    throw new UsageError(`Allowance must be a number, got "${allowanceArg}"`);
  }
  const task = taskWords.join(' ');

  const issued = await authorizeTask(runtime, { budget, taskId, task, allowance });
  return [
    `credential: ${issued.credential}`,
    `authorizationId: ${issued.authorization.authorizationId}`,
    `allowance: $${issued.authorization.allowance.toFixed(4)}`,
    `task: ${issued.authorization.task}`,
    `expiresAt: ${issued.authorization.expiresAt}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Add authorize command to runCli"
```

---

### Task 3: `delegate` command

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `delegateTaskAllowance(runtime, { parentCredential, agentId, allowance }): IssuedChildLease` from `src/handlers.ts` (synchronous, not a Promise), where `IssuedChildLease = { lease: InferenceLease, credential: string }`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
describe('runCli delegate', () => {
  it('delegates a child allowance and prints the child credential', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const parentCredential = issued.match(/credential: (\S+)/)![1];

    const output = await runCli(runtime, ['delegate', parentCredential, 'child-1', '0.5']);
    expect(output).toContain('credential: scrip_');
    expect(output).toContain('allowance: $0.5000');
    expect(output).toContain('depth: 1');
  });

  it('throws a UsageError when arguments are missing', async () => {
    await expect(runCli(runtime, ['delegate', 'some-credential', 'child-1'])).rejects.toThrow(UsageError);
  });

  it('throws for an invalid parent credential', async () => {
    await expect(runCli(runtime, ['delegate', 'not-a-real-credential', 'child-1', '0.5'])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `delegate` falls through to `UsageError` in `runCli`, so the first assertion (`toContain('credential: scrip_')`) fails.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add the case:

```typescript
    case 'delegate':
      return runDelegate(runtime, rest);
```

Update the import:

```typescript
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy } from './handlers.js';
```

Add the handler:

```typescript
function runDelegate(runtime: ScripRuntime, args: string[]): string {
  const [parentCredential, agentId, allowanceArg] = args;
  if (!parentCredential || !agentId || !allowanceArg) {
    throw new UsageError('Usage: scrip delegate <parentCredential> <agentId> <allowance>');
  }
  const allowance = Number(allowanceArg);
  if (Number.isNaN(allowance)) {
    throw new UsageError(`Allowance must be a number, got "${allowanceArg}"`);
  }

  const issued = delegateTaskAllowance(runtime, { parentCredential, agentId, allowance });
  return [
    `credential: ${issued.credential}`,
    `leaseId: ${issued.lease.leaseId}`,
    `allowance: $${issued.lease.allowance.toFixed(4)}`,
    `depth: ${issued.lease.depth}`,
    `expiresAt: ${issued.lease.expiresAt}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Add delegate command to runCli"
```

---

### Task 4: `settle` command with `--status`/`--evidence` flags

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `settleTask(runtime, authorizationId, outcome?: { status: TaskOutcomeStatus; evidence?: string }): Promise<TaskReceipt>` from `src/handlers.ts`; `TaskOutcomeStatus = 'success' | 'failure' | 'unknown'` from `src/store.ts`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
describe('runCli settle', () => {
  it('settles a task and prints the receipt summary', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, [
      'settle',
      authorizationId,
      '--status',
      'success',
      '--evidence',
      'All checks passed',
    ]);
    expect(output).toContain('actual: $0.0000');
    expect(output).toContain('returned: $1.0000');
    expect(output).toContain('requestCount: 0');
    expect(output).toContain('outcome: success');
    expect(output).toContain('outcomeEvidence: All checks passed');
  });

  it('settles a task with no outcome flags, defaulting to unknown', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, ['settle', authorizationId]);
    expect(output).toContain('outcome: unknown');
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['settle'])).rejects.toThrow(UsageError);
  });

  it('throws for an unknown authorizationId', async () => {
    await expect(runCli(runtime, ['settle', 'not-a-real-id'])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `settle` falls through to `UsageError` in `runCli`, so the first assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add the case:

```typescript
    case 'settle':
      return runSettle(runtime, rest);
```

Update the import:

```typescript
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, settleTask } from './handlers.js';
import type { TaskOutcomeStatus } from './store.js';
```

Add the handler:

```typescript
function parseFlags(args: string[]): { status?: string; evidence?: string } {
  const flags: { status?: string; evidence?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--status') flags.status = args[i + 1];
    else if (args[i] === '--evidence') flags.evidence = args[i + 1];
  }
  return flags;
}

async function runSettle(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [authorizationId, ...flagArgs] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip settle <authorizationId> [--status success|failure|unknown] [--evidence "text"]');

  const flags = parseFlags(flagArgs);
  const outcome = flags.status
    ? { status: flags.status as TaskOutcomeStatus, evidence: flags.evidence }
    : undefined;

  const receipt = await settleTask(runtime, authorizationId, outcome);
  const modelLines = receipt.modelUsage.map(
    (m) => `  ${m.model}: ${m.requests} requests, ${m.inputTokens} in / ${m.outputTokens} out, $${m.cost.toFixed(6)}`
  );
  return [
    `authorized: $${receipt.authorized.toFixed(4)}`,
    `actual: $${receipt.actual.toFixed(4)}`,
    `returned: $${receipt.returned.toFixed(4)}`,
    `requestCount: ${receipt.requestCount}`,
    `childAgents: ${receipt.childAgents}`,
    'modelUsage:',
    ...modelLines,
    `outcome: ${receipt.outcome}`,
    ...(receipt.outcomeEvidence ? [`outcomeEvidence: ${receipt.outcomeEvidence}`] : []),
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Add settle command to runCli"
```

---

### Task 5: `revoke` command

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `revokeTask(runtime, authorizationId): void` from `src/handlers.ts` (synchronous).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
describe('runCli revoke', () => {
  it('revokes a task and confirms it', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, ['revoke', authorizationId]);
    expect(output).toBe(`Revoked authorization ${authorizationId}`);

    // A revoked authorization can no longer be settled.
    await expect(runCli(runtime, ['settle', authorizationId])).rejects.toThrow();
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['revoke'])).rejects.toThrow(UsageError);
  });

  it('throws for an unknown authorizationId', async () => {
    await expect(runCli(runtime, ['revoke', 'not-a-real-id'])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `revoke` falls through to `UsageError` in `runCli`, so the first assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add the case:

```typescript
    case 'revoke':
      return runRevoke(runtime, rest);
```

Update the import:

```typescript
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, revokeTask, settleTask } from './handlers.js';
```

Add the handler:

```typescript
function runRevoke(runtime: ScripRuntime, args: string[]): string {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip revoke <authorizationId>');

  revokeTask(runtime, authorizationId);
  return `Revoked authorization ${authorizationId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Add revoke command to runCli"
```

---

### Task 6: `bin/cli.ts` bootstrap and `package.json` script

**Files:**
- Create: `bin/cli.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runCli`, `UsageError` from `src/cli.ts` (Tasks 1-5); `ScripRuntime` from `src/runtime.ts`.
- Produces: an executable entry point — no later task depends on this one's internals, since it's the outermost layer.

- [ ] **Step 1: Write the bootstrap script**

There is no unit test for `bin/cli.ts` itself — same as `bin/mcp-server.ts`, which also has no test file, since all testable logic lives in the `src/` module it wraps (verified by `tests/cli.test.ts` from Tasks 1-5). This step is verified manually in Step 2 instead.

Create `bin/cli.ts`:

```typescript
import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { runCli, UsageError } from '../src/cli.js';
import { ScripRuntime } from '../src/runtime.js';

async function main() {
  const runtime = new ScripRuntime(
    process.env.SCRIP_CONFIG ?? 'scrip.yaml',
    process.env.SCRIP_STORE ?? '.scrip/ramp.json'
  );
  const output = await runCli(runtime, process.argv.slice(2));
  console.log(output);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script and verify manually**

In `package.json`, add `"cli": "tsx bin/cli.ts"` to `"scripts"`, next to the existing `"mcp-server"` entry:

```json
    "mcp-server": "tsx bin/mcp-server.ts",
    "cli": "tsx bin/cli.ts",
```

Run these commands to verify the full lifecycle works end to end (uses `MockRampGateway` automatically, since no `RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` are required for this — it only needs `scrip.yaml` and writes to `.scrip/ramp.json`):

```bash
npm run cli -- status research
npm run cli -- authorize research manual-test-1 1 Manually testing the CLI
```

Expected: `status` prints the 8 policy lines from Task 1; `authorize` prints a `credential: scrip_...` line and an `authorizationId: ...` line. Copy the printed `authorizationId` and run:

```bash
npm run cli -- settle <authorizationId-from-previous-output> --status success --evidence "Manual smoke test"
```

Expected: prints `actual: $0.0000`, `returned: $1.0000`, `outcome: success`, `outcomeEvidence: Manual smoke test`.

Also verify the error paths:

```bash
npm run cli -- status not-a-real-budget
npm run cli --
```

Expected: the first prints `Error: Unknown Ramp budget "not-a-real-budget"` and exits 1 (check with `echo $?`); the second (no command) prints `Usage: scrip <status|authorize|delegate|settle|revoke> ...` and exits 1.

- [ ] **Step 3: Clean up the manual test artifact**

The manual run above wrote a real receipt to `.scrip/ramp.json` via `MockRampGateway`. Remove it so it doesn't get committed:

```bash
git status .scrip/
```

If `.scrip/` is already gitignored (check `.gitignore`), no action needed. If not, add `.scrip/` to `.gitignore` before committing (it's local runtime state, same as why `demo/run-demo.ts` uses `.scrip/ramp.json` without ever committing it).

- [ ] **Step 4: Commit**

```bash
git add bin/cli.ts package.json
git commit -m "Add bin/cli.ts bootstrap and npm run cli script"
```

---

### Task 7: Full verification

**Files:** None (verification only).

**Interfaces:** None.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 18 tests in `tests/cli.test.ts` from Tasks 1-5 and every pre-existing test file (73 tests as of the last multi-provider commit, so ≥91 total).

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: `tsc -p tsconfig.json` completes with no errors, confirming `bin/cli.ts` and `src/cli.ts` type-check cleanly alongside the rest of the project.

- [ ] **Step 3: Commit if either step required fixes**

If Steps 1-2 required any code changes, commit them:

```bash
git add -A
git commit -m "Fix issues found during CLI full verification"
```

If no changes were needed, skip this step — nothing to commit.
