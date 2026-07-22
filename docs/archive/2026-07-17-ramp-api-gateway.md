# Production RampGateway Adapter Implementation Plan

> Archived plan. This document describes an obsolete product direction
> and is not the current architecture. The implementation it plans has
> since been completed and live-verified - see docs/ramp-api-notes.md.

> **Needs a refresh pass before execution** — written before three
> corrections landed (see
> [`docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`](../specs/2026-07-17-ramp-api-gateway-design.md)'s
> amendments): SpecSpend → Scrip renaming throughout; `ramp_limit_id` →
> `ramp_fund_id` (Ramp's real resource is Funds, not "Limits"); the OAuth
> token request should default to HTTP Basic Auth, not the body-based
> grant this plan's `RampOAuthClient` task describes. It also predates the
> `Meter`/`ai-usage/unified` write-path design
> ([`2026-07-18-ai-usage-tracking-positioning.md`](../specs/2026-07-18-ai-usage-tracking-positioning.md))
> — `reportTaskUsage()` can be a real write, not permanently local-only.
> Not yet executed as of this note; re-verify each task against current
> `src/` before running it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, OAuth-backed `RampApiGateway` that reads live Ramp spend-limit balances, wire it into the (currently synchronous) `RampGateway`/`TaskAuthorizationManager` chain by converting the three methods that touch it to `async`, and set up `.env`-based credential loading so real Ramp API keys can be dropped in before the demo with zero further code changes.

**Architecture:** `RampGateway.getReportedSpend()`/`reportTaskUsage()` become `Promise`-returning. `RampOAuthClient` handles client-credentials token acquisition with in-memory caching. `RampApiGateway` implements `RampGateway`: real HTTP reads for balance, and local-JSON-file writes (via a `LocalReceiptStore` extracted out of the existing `MockRampGateway`) for receipts, since a real Ramp write requires Vault approval this project doesn't have. A `createRampGateway()` factory in `src/runtime.ts` picks the real adapter when `RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` env vars are present, otherwise falls back to `MockRampGateway`.

**Tech Stack:** TypeScript (Node 20.6+ for `process.loadEnvFile`), `vitest`, no new npm dependencies (HTTP is done via the platform `fetch`, injected as a constructor dependency for testability).

## Global Constraints

- `RampGateway.getReportedSpend()` throws on auth/network failure — no silent fallback to a stale or zero number (per the design doc).
- `RampApiGateway.reportTaskUsage()` writes locally only; it must not claim a real Ramp financial write, since that requires Vault approval this project doesn't have.
- The exact Ramp API response shape is an explicit known unknown. `RampApiGateway`'s HTTP-parsing code is written against whatever is filled into `docs/ramp-api-notes.md`; if that file is still unfilled when Task 7 is implemented, use the documented placeholder `{ "balance": number }` shape and say so explicitly — never invent Ramp-specific field names and present them as verified.
- No test may call the real Ramp API. All HTTP is injected and faked in tests.
- Every existing test in `tests/` must still pass after the async conversion — this plan is a refactor of live, working code, not a rewrite.

---

### Task 1: `.env` credential loading

**Files:**
- Create: `.env.example`
- Modify: `bin/mcp-server.ts`
- Modify: `demo/run-demo.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`, `RAMP_API_BASE_URL` become available via `process.env` in both entry points whenever a `.env` file is present, used by `createRampGateway()` (Task 9).

- [ ] **Step 1: Create `.env.example`**

```
# Ramp Developer API credentials (sandbox or production).
# Leave RAMP_CLIENT_ID / RAMP_CLIENT_SECRET unset to run against the local
# MockRampGateway instead of a real Ramp connection.
RAMP_CLIENT_ID=
RAMP_CLIENT_SECRET=
RAMP_API_BASE_URL=https://sandbox-api.ramp.com

ANTHROPIC_API_KEY=
```

- [ ] **Step 2: Copy it to a real, gitignored `.env` so there's an obvious place to paste keys**

Run: `cp .env.example .env`
Expected: `.env` created (already covered by the existing `.env` line in `.gitignore` — confirm with `git check-ignore .env`, expected output: `.env`).

- [ ] **Step 3: Add env loading to `bin/mcp-server.ts`**

```ts
import { existsSync } from 'node:fs';
import { startMcpServer } from '../src/mcp-server.js';
import { SpecSpendRuntime } from '../src/runtime.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const runtime = new SpecSpendRuntime(
  process.env.SPECSPEND_CONFIG ?? 'specspend.yaml',
  process.env.SPECSPEND_STORE ?? '.specspend/ramp.json'
);
startMcpServer(runtime);
```

- [ ] **Step 4: Add env loading to `demo/run-demo.ts`**

Add these two lines at the very top of the file, before the existing imports remain unchanged below them:

```ts
import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
```

The full top of the file now reads:

```ts
import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import Anthropic from '@anthropic-ai/sdk';
import { authorizeTask, delegateTaskAllowance, settleTask } from '../src/handlers.js';
import { SpecSpendClient } from '../src/proxy.js';
import { SpecSpendRuntime } from '../src/runtime.js';
```

(The rest of `demo/run-demo.ts` is unchanged by this task — its `authorizeTask`/`settleTask` calls get `await` added in Task 5.)

- [ ] **Step 5: Verify env loading works**

Run: `echo 'RAMP_CLIENT_ID=test-value' >> .env && node -e "if (require('node:fs').existsSync('.env')) process.loadEnvFile('.env'); console.log(process.env.RAMP_CLIENT_ID)"`
Expected: `test-value` printed.

Run: `git checkout .env 2>/dev/null; cp .env.example .env` to restore `.env` to its blank template afterward (don't leave the test value sitting in your real `.env`).

- [ ] **Step 6: Commit**

```bash
git add .env.example bin/mcp-server.ts demo/run-demo.ts
git commit -m "Add .env-based Ramp credential loading to entry points"
```

Note: `.env` itself is gitignored and stays out of this commit — only `.env.example` is tracked.

---

### Task 2: Ramp API reference doc

**Files:**
- Create: `docs/ramp-api-notes.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a reference the user fills in before Task 7, and that Task 7's implementer reads to decide between real field names and the documented placeholder shape.

- [ ] **Step 1: Create `docs/ramp-api-notes.md`**

```markdown
# Ramp API notes

Filled in from Ramp's real developer documentation
(https://docs.ramp.com/developer-api) before `RampApiGateway`'s HTTP-parsing
code is written. If any field below is still blank when that task starts,
the implementation uses the placeholder shape noted inline instead of
guessing — update this file first if you want the real shape used.

## OAuth token endpoint

- Full URL: _(fill in, e.g. `https://api.ramp.com/developer/v1/token`)_
- Grant type: `client_credentials` (confirmed by Ramp's public docs)
- Required scopes for reading spend limits: _(fill in)_
- Token response field for the access token: _(fill in, placeholder assumes `access_token`)_
- Token response field for expiry seconds: _(fill in, placeholder assumes `expires_in`)_

## Spend-limit / budget balance endpoint

- Full URL pattern: _(fill in, e.g. `https://api.ramp.com/developer/v1/limits/{id}`)_
- Path or query param used to select a specific limit: _(fill in)_
- Response field for the remaining/available balance: _(fill in — if
  unfilled, `RampApiGateway` reads a top-level `balance: number` field as a
  placeholder)_
- Response field for the currency, if not always USD: _(fill in)_

## Auth header format

- e.g. `Authorization: Bearer <token>` — confirm exact header name and scheme.

## Known constraints

- Vault / virtual-card issuance requires separate Ramp approval and PCI
  scopes — out of scope for this adapter (see
  `docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`).
- Sandbox vs. production base URLs: _(fill in if they differ from
  `RAMP_API_BASE_URL` swapping the host)_
```

- [ ] **Step 2: Commit**

```bash
git add docs/ramp-api-notes.md
git commit -m "Add fill-in-the-blank Ramp API reference doc"
```

---

### Task 3: Extract `LocalReceiptStore`, make `RampGateway` async

**Files:**
- Modify: `src/store.ts`
- Modify: `tests/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `LocalReceiptStore` class with `addReceipt(receipt: TaskReceipt): void`, `getSpend(rampBudgetId: string, sinceMonth?: string): number`, `getReceipts(): TaskReceipt[]` (all still synchronous — it's a local file, no I/O latency to hide) — used by `MockRampGateway` (this task) and `RampApiGateway` (Task 7). `RampGateway` interface changes to `getReportedSpend(rampBudgetId: string, sinceMonth?: string): Promise<number>` and `reportTaskUsage(receipt: TaskReceipt): Promise<void>` — used by every later task that touches a `RampGateway`.

- [ ] **Step 1: Update the test to await the (soon-to-be-async) interface**

Replace `tests/store.test.ts` with:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockRampGateway, type TaskReceipt } from '../src/store.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-ramp-'));
  filePath = path.join(tmpDir, 'ramp.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    receiptId: 'receipt-1',
    authorizationId: 'auth-1',
    rampEntityId: 'entity-1',
    rampBudgetId: 'budget-1',
    team: 'agents',
    taskId: 'task-1',
    task: 'Review code',
    authorized: 2,
    actual: 0.5,
    returned: 1.5,
    childAgents: 1,
    requestCount: 1,
    modelUsage: [],
    costCenter: 'AI compute',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MockRampGateway', () => {
  it('persists task receipts and reports spend by Ramp budget', async () => {
    const ramp = new MockRampGateway(filePath);
    await ramp.reportTaskUsage(receipt());
    await ramp.reportTaskUsage(receipt({ receiptId: 'receipt-2', actual: 0.25 }));
    await ramp.reportTaskUsage(receipt({ receiptId: 'receipt-3', rampBudgetId: 'budget-2', actual: 9 }));
    expect(await ramp.getReportedSpend('budget-1')).toBeCloseTo(0.75);
    expect(ramp.getReceipts()).toHaveLength(3);
  });

  it('excludes receipts outside the requested month', async () => {
    const ramp = new MockRampGateway(filePath);
    await ramp.reportTaskUsage(receipt({ settledAt: '2020-01-15T00:00:00.000Z' }));
    expect(await ramp.getReportedSpend('budget-1', '2026-07')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it still passes against the current sync implementation**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (2 tests) — `await` on an already-resolved value is a no-op, so this confirms the test itself is correct before the implementation changes underneath it.

- [ ] **Step 3: Refactor `src/store.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface TaskReceipt {
  receiptId: string;
  authorizationId: string;
  rampEntityId: string;
  rampBudgetId: string;
  team: string;
  taskId: string;
  task: string;
  authorized: number;
  actual: number;
  returned: number;
  childAgents: number;
  requestCount: number;
  modelUsage: ModelUsage[];
  costCenter: string;
  startedAt: string;
  settledAt: string;
}

interface StoreData {
  receipts: TaskReceipt[];
}

export interface RampGateway {
  getReportedSpend(rampBudgetId: string, sinceMonth?: string): Promise<number>;
  reportTaskUsage(receipt: TaskReceipt): Promise<void>;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Local JSON-file receipt persistence, shared by every RampGateway implementation. */
export class LocalReceiptStore {
  constructor(private filePath: string) {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.save({ receipts: [] });
    }
  }

  private load(): StoreData {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  private save(data: StoreData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n');
  }

  addReceipt(receipt: TaskReceipt): void {
    const data = this.load();
    data.receipts.push(receipt);
    this.save(data);
    console.log(
      `[ramp] budget=${receipt.rampBudgetId} task=${receipt.taskId} ` +
        `authorized=$${receipt.authorized.toFixed(4)} actual=$${receipt.actual.toFixed(4)} ` +
        `returned=$${receipt.returned.toFixed(4)}`
    );
  }

  getSpend(rampBudgetId: string, sinceMonth: string = currentMonth()): number {
    return this.load().receipts
      .filter((receipt) => receipt.rampBudgetId === rampBudgetId && receipt.settledAt.startsWith(sinceMonth))
      .reduce((sum, receipt) => sum + receipt.actual, 0);
  }

  getReceipts(): TaskReceipt[] {
    return this.load().receipts;
  }
}

/** Local Ramp boundary used by the demo. Replace this adapter, not the lease engine. */
export class MockRampGateway implements RampGateway {
  private store: LocalReceiptStore;

  constructor(filePath: string) {
    this.store = new LocalReceiptStore(filePath);
  }

  async reportTaskUsage(receipt: TaskReceipt): Promise<void> {
    this.store.addReceipt(receipt);
  }

  async getReportedSpend(rampBudgetId: string, sinceMonth?: string): Promise<number> {
    return this.store.getSpend(rampBudgetId, sinceMonth);
  }

  getReceipts(): TaskReceipt[] {
    return this.store.getReceipts();
  }
}
```

- [ ] **Step 4: Run test to verify it still passes against the new implementation**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "Extract LocalReceiptStore and make RampGateway async"
```

---

### Task 4: Make `TaskAuthorizationManager`'s Ramp-touching methods async

**Files:**
- Modify: `src/lease.ts`
- Modify: `tests/lease.test.ts`

**Interfaces:**
- Consumes: `RampGateway` (Task 3, now `Promise`-returning).
- Produces: `TaskAuthorizationManager.getBudgetRemaining(name: string): Promise<number>`, `authorizeTask(params): Promise<IssuedTaskAuthorization>`, `settleTask(authorizationId: string): Promise<TaskReceipt>` — all other methods (`delegate`, `reserveRequest`, `commitRequest`, `cancelRequest`, `revokeTask`, `getAuthorization`, `getAuthorizationForCredential`, `getLeaseForCredential`) are unchanged and stay synchronous since they never touch `RampGateway`. Used by `handlers.ts`, `proxy.ts`'s tests, and `demo/run-demo.ts` (Task 5).

- [ ] **Step 1: Update `tests/lease.test.ts` to await the async methods**

Replace `tests/lease.test.ts` with:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  InvalidCredentialError,
  SpendLimitExceededError,
  TaskAuthorizationManager,
} from '../src/lease.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let ramp: MockRampGateway;
let manager: TaskAuthorizationManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-lease-'));
  ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  manager = new TaskAuthorizationManager(loadConfig('specspend.yaml'), ramp);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function authorize(allowance = 2, ttlMs?: number) {
  return manager.authorizeTask({ budget: 'research', taskId: 'task-1', task: 'Review a repository', allowance, ttlMs });
}

describe('TaskAuthorizationManager', () => {
  it('mints an opaque task credential and reserves Ramp budget', async () => {
    const issued = await authorize();
    expect(issued.credential).toMatch(/^ss_task_/);
    expect(JSON.stringify(issued.authorization)).not.toContain(issued.credential);
    expect(await manager.getBudgetRemaining('research')).toBe(98);
  });

  it('enforces Ramp policy on task allowance', async () => {
    await expect(authorize(11)).rejects.toThrow(SpendLimitExceededError);
  });

  it('delegates a bounded lease to a child agent', async () => {
    const root = await authorize();
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    expect(child.lease.parentLeaseId).toBe(root.lease.leaseId);
    expect(child.lease.allowance).toBe(0.5);
    expect(() => manager.delegate(root.credential, 'researcher-2', 1.6)).toThrow(SpendLimitExceededError);
  });

  it('prevents concurrent requests from oversubscribing one lease', async () => {
    const root = await authorize(1);
    manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.7);
    expect(() =>
      manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.4)
    ).toThrow(SpendLimitExceededError);
  });

  it('releases a failed request reservation', async () => {
    const root = await authorize(1);
    const request = manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.8);
    manager.cancelRequest(request.reservationId);
    expect(() => manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 1)).not.toThrow();
  });

  it('rejects disallowed models and invalid credentials', async () => {
    const root = await authorize();
    expect(() => manager.reserveRequest(root.credential, 'gpt-not-allowed', 0.1)).toThrow(SpendLimitExceededError);
    expect(() => manager.getLeaseForCredential('not-a-credential')).toThrow(InvalidCredentialError);
  });

  it('rejects an expired credential', async () => {
    const root = await authorize(1, -1);
    expect(() => manager.getAuthorizationForCredential(root.credential)).toThrow(InvalidCredentialError);
  });

  it('settles one receipt for root and child usage and reports it to Ramp', async () => {
    const root = await authorize(2);
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    const rootRequest = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(rootRequest.reservationId, 100, 50, 0.2);
    const childRequest = manager.reserveRequest(child.credential, 'claude-haiku-4-5-20251001', 0.3);
    manager.commitRequest(childRequest.reservationId, 80, 40, 0.1);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.3);
    expect(receipt.returned).toBeCloseTo(1.7);
    expect(receipt.childAgents).toBe(1);
    expect(receipt.requestCount).toBe(2);
    expect(receipt.modelUsage).toHaveLength(2);
    expect(await ramp.getReportedSpend('ramp-budget-research')).toBeCloseTo(0.3);
    expect(await manager.getBudgetRemaining('research')).toBeCloseTo(99.7);
    expect(() => manager.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails against the current sync implementation**

Run: `npx vitest run tests/lease.test.ts`
Expected: FAIL — `authorize(11)` no longer synchronously throws (it's a resolved value now awaited), so `await expect(authorize(11)).rejects.toThrow(...)` fails because the promise resolves instead of rejecting. This confirms the test now depends on the async behavior we're about to implement.

- [ ] **Step 3: Convert the three Ramp-touching methods in `src/lease.ts` to `async`**

In `src/lease.ts`, change `getBudgetRemaining`:

```ts
  async getBudgetRemaining(name: string): Promise<number> {
    const budget = this.budget(name);
    const reported = await this.ramp.getReportedSpend(budget.rampBudgetId);
    const activeAllowances = [...this.authorizations.values()]
      .filter((authorization) => authorization.budgetName === name && authorization.status === 'active')
      .reduce((sum, authorization) => sum + authorization.allowance, 0);
    return budget.monthlyLimit - reported - activeAllowances;
  }
```

Change `authorizeTask`:

```ts
  async authorizeTask(params: {
    budget: string;
    taskId: string;
    task: string;
    allowance: number;
    ttlMs?: number;
  }): Promise<IssuedTaskAuthorization> {
    const budget = this.budget(params.budget);
    if (params.allowance <= 0 || params.allowance > budget.maxTaskAllowance) {
      throw new SpendLimitExceededError(
        `Task allowance must be between $0 and $${budget.maxTaskAllowance.toFixed(4)}`
      );
    }
    const remaining = await this.getBudgetRemaining(params.budget);
    if (params.allowance > remaining) {
      throw new SpendLimitExceededError(
        `Cannot authorize $${params.allowance.toFixed(4)} from Ramp budget ${budget.rampBudgetId}: ` +
          `$${remaining.toFixed(4)} remains`
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? budget.taskTtlSeconds * 1000)).toISOString();
    const authorization: TaskAuthorization = {
      authorizationId: randomUUID(),
      budgetName: params.budget,
      rampBudgetId: budget.rampBudgetId,
      taskId: params.taskId,
      task: params.task,
      allowance: params.allowance,
      spent: 0,
      pending: 0,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt,
    };
    const credential = issueCredential();
    const lease: InternalLease = {
      leaseId: randomUUID(),
      authorizationId: authorization.authorizationId,
      agentId: 'root',
      allowance: params.allowance,
      spent: 0,
      pending: 0,
      status: 'active',
      expiresAt,
      credentialHash: hashCredential(credential),
    };
    this.authorizations.set(authorization.authorizationId, authorization);
    this.leases.set(lease.leaseId, lease);
    this.usage.set(authorization.authorizationId, []);
    return { authorization: { ...authorization }, lease: this.publicLease(lease), credential };
  }
```

Change `settleTask`:

```ts
  async settleTask(authorizationId: string): Promise<TaskReceipt> {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0) throw new Error('Cannot settle a task with requests in flight');
    authorization.status = 'settled';
    const leases = [...this.leases.values()].filter((lease) => lease.authorizationId === authorizationId);
    leases.forEach((lease) => (lease.status = 'settled'));
    const events = this.usage.get(authorizationId) ?? [];
    const budget = this.budget(authorization.budgetName);
    const byModel = new Map<string, ModelUsage>();
    for (const event of events) {
      const aggregate = byModel.get(event.model) ?? {
        model: event.model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      aggregate.requests += 1;
      aggregate.inputTokens += event.inputTokens;
      aggregate.outputTokens += event.outputTokens;
      aggregate.cost += event.cost;
      byModel.set(event.model, aggregate);
    }
    const receipt: TaskReceipt = {
      receiptId: randomUUID(),
      authorizationId,
      rampEntityId: this.config.rampEntityId,
      rampBudgetId: authorization.rampBudgetId,
      team: this.config.team,
      taskId: authorization.taskId,
      task: authorization.task,
      authorized: authorization.allowance,
      actual: authorization.spent,
      returned: authorization.allowance - authorization.spent,
      childAgents: leases.filter((lease) => lease.parentLeaseId).length,
      requestCount: events.length,
      modelUsage: [...byModel.values()],
      costCenter: budget.costCenter,
      startedAt: authorization.createdAt,
      settledAt: new Date().toISOString(),
    };
    await this.ramp.reportTaskUsage(receipt);
    return receipt;
  }
```

Every other method in the class (`delegate`, `reserveRequest`, `commitRequest`, `cancelRequest`, `revokeTask`, `getAuthorization`, `getAuthorizationForCredential`, `getLeaseForCredential`, and the private helpers) is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lease.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lease.ts tests/lease.test.ts
git commit -m "Make TaskAuthorizationManager's Ramp-touching methods async"
```

---

### Task 5: Propagate `async` through handlers, MCP server, demo, and remaining tests

**Files:**
- Modify: `src/handlers.ts`
- Modify: `src/mcp-server.ts`
- Modify: `demo/run-demo.ts`
- Modify: `tests/handlers.test.ts`
- Modify: `tests/proxy.test.ts`
- Modify: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `TaskAuthorizationManager` (Task 4).
- Produces: `getBudgetPolicy(runtime, budgetName): Promise<...>`, `authorizeTask(runtime, params): Promise<IssuedTaskAuthorization>`, `settleTask(runtime, authorizationId): Promise<TaskReceipt>` in `src/handlers.ts` (unchanged: `delegateTaskAllowance`, `revokeTask` stay synchronous). Used by `mcp-server.ts`, `demo/run-demo.ts`, and any future caller.

- [ ] **Step 1: Update `src/handlers.ts`**

```ts
import type { SpecSpendRuntime } from './runtime.js';

export async function getBudgetPolicy(runtime: SpecSpendRuntime, budgetName: string) {
  const budget = runtime.getBudget(budgetName);
  const reportedSpend = await runtime.ramp.getReportedSpend(budget.rampBudgetId);
  return {
    rampBudgetId: budget.rampBudgetId,
    monthlyLimit: budget.monthlyLimit,
    reportedSpend,
    availableToAuthorize: await runtime.authorizations.getBudgetRemaining(budgetName),
    maxTaskAllowance: budget.maxTaskAllowance,
    allowedModels: budget.allowedModels,
    fallbackModel: budget.fallbackModel,
    onLimit: budget.onLimit,
  };
}

export async function authorizeTask(
  runtime: SpecSpendRuntime,
  params: { budget: string; taskId: string; task: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.authorizeTask(params);
}

export function delegateTaskAllowance(
  runtime: SpecSpendRuntime,
  params: { parentCredential: string; agentId: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.delegate(params.parentCredential, params.agentId, params.allowance, params.ttlMs);
}

export async function settleTask(runtime: SpecSpendRuntime, authorizationId: string) {
  return runtime.authorizations.settleTask(authorizationId);
}

export function revokeTask(runtime: SpecSpendRuntime, authorizationId: string): void {
  runtime.authorizations.revokeTask(authorizationId);
}
```

- [ ] **Step 2: Update `src/mcp-server.ts` to await the now-async handlers**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, settleTask } from './handlers.js';
import type { SpecSpendRuntime } from './runtime.js';

/** Optional agent adapter. The runtime credential API remains the product boundary. */
export function createMcpServer(runtime: SpecSpendRuntime): McpServer {
  const server = new McpServer({ name: 'specspend', version: '0.2.0' });

  server.tool(
    'get_ramp_budget_policy',
    'Read the Ramp-backed policy available for task authorization.',
    { budget: z.string() },
    async ({ budget }) => ({
      content: [{ type: 'text', text: JSON.stringify(await getBudgetPolicy(runtime, budget)) }],
    })
  );

  server.tool(
    'authorize_ai_task',
    'Mint one temporary inference credential backed by a Ramp budget.',
    { budget: z.string(), taskId: z.string(), task: z.string(), allowance: z.number().positive() },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify(await authorizeTask(runtime, params)) }],
    })
  );

  server.tool(
    'delegate_task_allowance',
    'Create a bounded child-agent lease from a task credential.',
    { parentCredential: z.string(), agentId: z.string(), allowance: z.number().positive() },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify(delegateTaskAllowance(runtime, params)) }],
    })
  );

  server.tool(
    'settle_ai_task',
    'Close a task authorization, emit its receipt, and report usage to Ramp.',
    { authorizationId: z.string() },
    async ({ authorizationId }) => ({
      content: [{ type: 'text', text: JSON.stringify(await settleTask(runtime, authorizationId)) }],
    })
  );

  return server;
}

export async function startMcpServer(runtime: SpecSpendRuntime): Promise<void> {
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 3: Update `demo/run-demo.ts` to await the now-async calls**

The file (with Task 1's env-loading lines already at the top) becomes:

```ts
import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import Anthropic from '@anthropic-ai/sdk';
import { authorizeTask, delegateTaskAllowance, settleTask } from '../src/handlers.js';
import { SpecSpendClient } from '../src/proxy.js';
import { SpecSpendRuntime } from '../src/runtime.js';

async function main() {
  const runtime = new SpecSpendRuntime('specspend.yaml', '.specspend/ramp.json');
  const client = new SpecSpendClient(runtime, new Anthropic());
  const task = await authorizeTask(runtime, {
    budget: 'research',
    taskId: `research-${Date.now()}`,
    task: 'Research authentication libraries in this repository',
    allowance: 1,
  });

  console.log(`Task credential issued with $${task.authorization.allowance.toFixed(2)} allowance`);
  const children = [1, 2].map((agent) =>
    delegateTaskAllowance(runtime, {
      parentCredential: task.credential,
      agentId: `researcher-${agent}`,
      allowance: 0.4,
    })
  );

  await Promise.all(
    children.map((child, index) =>
      client.run({
        credential: child.credential,
        estimatedInputTokens: 500,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: `Summarize authentication library practices, focusing on aspect ${index + 1}.`,
          },
        ],
      })
    )
  );

  const receipt = await settleTask(runtime, task.authorization.authorizationId);
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Update `tests/handlers.test.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, revokeTask, settleTask } from '../src/handlers.js';
import { InvalidCredentialError } from '../src/lease.js';
import { SpecSpendRuntime } from '../src/runtime.js';

let tmpDir: string;
let runtime: SpecSpendRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-handlers-'));
  runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('task credential handlers', () => {
  it('exposes Ramp policy and available task authorization', async () => {
    expect(await getBudgetPolicy(runtime, 'research')).toMatchObject({
      rampBudgetId: 'ramp-budget-research',
      monthlyLimit: 100,
      availableToAuthorize: 100,
      maxTaskAllowance: 10,
    });
  });

  it('authorizes, delegates, and settles a task', async () => {
    const root = await authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 2,
    });
    const child = delegateTaskAllowance(runtime, {
      parentCredential: root.credential,
      agentId: 'child-1',
      allowance: 0.5,
    });
    expect(child.lease.authorizationId).toBe(root.authorization.authorizationId);
    expect(await settleTask(runtime, root.authorization.authorizationId)).toMatchObject({
      authorized: 2,
      actual: 0,
      childAgents: 1,
    });
  });

  it('revokes every credential in the task tree', async () => {
    const root = await authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 1,
    });
    revokeTask(runtime, root.authorization.authorizationId);
    expect(() => runtime.authorizations.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });
});
```

- [ ] **Step 5: Update `tests/proxy.test.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendLimitExceededError } from '../src/lease.js';
import { SpecSpendClient } from '../src/proxy.js';
import { SpecSpendRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let runtime: SpecSpendRuntime;
let ramp: MockRampGateway;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-proxy-'));
  ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'unused.json'), ramp);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function issue(allowance = 1) {
  return runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: 'task-1',
    task: 'Review code',
    allowance,
  });
}

function fakeAnthropic(usage = { input_tokens: 500, output_tokens: 300 }) {
  return {
    messages: {
      create: vi.fn(async () => ({ id: 'msg_test', usage, content: [{ type: 'text', text: 'ok' }] })),
    },
  } as any;
}

const request = {
  estimatedInputTokens: 500,
  maxTokens: 300,
  messages: [{ role: 'user' as const, content: 'Review this code' }],
};

describe('SpecSpendClient', () => {
  it('preauthorizes a provider call, commits actual usage, then settles one task receipt', async () => {
    const root = await issue();
    const anthropic = fakeAnthropic();
    const client = new SpecSpendClient(runtime, anthropic);
    const result = await client.run({ ...request, credential: root.credential });

    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    expect(result.actualCost).toBeGreaterThan(0);
    const receipt = await runtime.authorizations.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(result.actualCost);
    expect(receipt.requestCount).toBe(1);
    expect(receipt.modelUsage[0].inputTokens).toBe(500);
  });

  it('blocks an unaffordable call before provider network I/O', async () => {
    const root = await issue(0.001);
    const anthropic = fakeAnthropic();
    const client = new SpecSpendClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('releases the request reservation when the provider fails', async () => {
    const root = await issue(0.1);
    const anthropic = {
      messages: { create: vi.fn(async () => Promise.reject(new Error('provider unavailable'))) },
    } as any;
    const client = new SpecSpendClient(runtime, anthropic);
    await expect(client.run({ ...request, credential: root.credential })).rejects.toThrow('provider unavailable');
    expect(runtime.authorizations.getAuthorization(root.authorization.authorizationId).pending).toBeCloseTo(0);
  });

  it('enforces a child agent allowance independently of the parent task', async () => {
    const root = await issue(1);
    const child = runtime.authorizations.delegate(root.credential, 'child-1', 0.001);
    const anthropic = fakeAnthropic();
    const client = new SpecSpendClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: child.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Update `tests/runtime.test.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpecSpendRuntime } from '../src/runtime.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-runtime-'));
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('SpecSpendRuntime', () => {
  it('wires Ramp policy, task authorizations, and routing', async () => {
    const runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
    expect(runtime.config.rampEntityId).toBe('ramp-entity-demo');
    expect(await runtime.authorizations.getBudgetRemaining('research')).toBe(100);
    expect(runtime.getBudget('research').rampBudgetId).toBe('ramp-budget-research');
  });

  it('rejects an unknown Ramp budget', () => {
    const runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
    expect(() => runtime.getBudget('unknown')).toThrow('Unknown Ramp budget');
  });
});
```

- [ ] **Step 7: Run the full test suite and the build**

Run: `npm test && npm run build`
Expected: all test files pass; `tsc` reports no errors (this catches any remaining un-awaited call sites as type errors, since `authorizeTask`/`settleTask`/`getBudgetPolicy`/`getBudgetRemaining`/`getReportedSpend`/`reportTaskUsage` now return `Promise<...>`).

- [ ] **Step 8: Commit**

```bash
git add src/handlers.ts src/mcp-server.ts demo/run-demo.ts tests/handlers.test.ts tests/proxy.test.ts tests/runtime.test.ts
git commit -m "Propagate async RampGateway through handlers, MCP server, and demo"
```

---

### Task 6: `RampOAuthClient`

**Files:**
- Create: `src/ramp-oauth.ts`
- Test: `tests/ramp-oauth.test.ts`

**Interfaces:**
- Consumes: nothing new (a `fetch`-shaped function injected by the caller).
- Produces: `RampOAuthConfig` type, `HttpFetch` type alias, and `RampOAuthClient` class with `async getAccessToken(): Promise<string>` — used by `RampApiGateway` (Task 7).

- [ ] **Step 1: Write the failing test**

Create `tests/ramp-oauth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RampOAuthClient } from '../src/ramp-oauth.js';

function fakeFetch(responses: Array<{ access_token: string; expires_in: number }>) {
  let call = 0;
  return vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  });
}

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  tokenUrl: 'https://sandbox-api.ramp.com/developer/v1/token',
};

describe('RampOAuthClient', () => {
  it('fetches an access token using a client-credentials grant', async () => {
    const fetchFn = fakeFetch([{ access_token: 'token-abc', expires_in: 3600 }]);
    const client = new RampOAuthClient(config, fetchFn);

    const token = await client.getAccessToken();

    expect(token).toBe('token-abc');
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(config.tokenUrl);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('grant_type=client_credentials');
  });

  it('reuses a cached token until it is near expiry', async () => {
    const fetchFn = fakeFetch([{ access_token: 'token-abc', expires_in: 3600 }]);
    const client = new RampOAuthClient(config, fetchFn);

    await client.getAccessToken();
    await client.getAccessToken();

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('re-fetches once the cached token is within 60 seconds of expiry', async () => {
    const fetchFn = fakeFetch([
      { access_token: 'token-abc', expires_in: 30 },
      { access_token: 'token-def', expires_in: 3600 },
    ]);
    const client = new RampOAuthClient(config, fetchFn);

    const first = await client.getAccessToken();
    const second = await client.getAccessToken();

    expect(first).toBe('token-abc');
    expect(second).toBe('token-def');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws when the token endpoint responds with an error', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_client' }),
    } as Response));
    const client = new RampOAuthClient(config, fetchFn);

    await expect(client.getAccessToken()).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ramp-oauth.test.ts`
Expected: FAIL — `Cannot find module '../src/ramp-oauth.js'`.

- [ ] **Step 3: Implement `src/ramp-oauth.ts`**

```ts
export interface RampOAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export type HttpFetch = typeof fetch;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export class RampOAuthClient {
  private cached: CachedToken | null = null;

  constructor(private config: RampOAuthConfig, private fetchFn: HttpFetch = fetch) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return this.cached.accessToken;
    }

    const response = await this.fetchFn(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Ramp OAuth token request failed with status ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cached = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return this.cached.accessToken;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ramp-oauth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ramp-oauth.ts tests/ramp-oauth.test.ts
git commit -m "Add RampOAuthClient with client-credentials grant and token caching"
```

---

### Task 7: `RampApiGateway`

**Files:**
- Create: `src/ramp-api-gateway.ts`
- Test: `tests/ramp-api-gateway.test.ts`

**Interfaces:**
- Consumes: `RampGateway`, `LocalReceiptStore`, `TaskReceipt` (Task 3); `RampOAuthClient`, `HttpFetch` (Task 6).
- Produces: `RampApiGatewayConfig` type, `RampApiGateway implements RampGateway` — used by `createRampGateway()` (Task 9).

- [ ] **Step 1: Check `docs/ramp-api-notes.md` for a confirmed response shape**

Open `docs/ramp-api-notes.md`. If the "Response field for the remaining/available balance" line has been filled in with a real field name, use that field name in Step 3 below instead of the placeholder `balance` field, and note the substitution in the commit message. If it's still blank, proceed with the placeholder shape as written — this is expected for a project still waiting on sandbox credentials, not a gap to silently paper over.

- [ ] **Step 2: Write the failing test**

Create `tests/ramp-api-gateway.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RampApiGateway } from '../src/ramp-api-gateway.js';

let tmpDir: string;
let receiptPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-ramp-api-'));
  receiptPath = path.join(tmpDir, 'ramp.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  baseUrl: 'https://sandbox-api.ramp.com',
};

function fakeFetch(handlers: { token: object; balance: object; balanceStatus?: number }) {
  return vi.fn(async (url: string | URL) => {
    const href = url.toString();
    if (href.includes('/token')) {
      return { ok: true, status: 200, json: async () => handlers.token } as Response;
    }
    return {
      ok: (handlers.balanceStatus ?? 200) < 400,
      status: handlers.balanceStatus ?? 200,
      json: async () => handlers.balance,
    } as Response;
  });
}

function receipt(overrides: Partial<Parameters<RampApiGateway['reportTaskUsage']>[0]> = {}) {
  return {
    receiptId: 'receipt-1',
    authorizationId: 'auth-1',
    rampEntityId: 'entity-1',
    rampBudgetId: 'budget-1',
    team: 'agents',
    taskId: 'task-1',
    task: 'Review code',
    authorized: 2,
    actual: 0.5,
    returned: 1.5,
    childAgents: 0,
    requestCount: 1,
    modelUsage: [],
    costCenter: 'AI compute',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('RampApiGateway', () => {
  it('reads a real balance from Ramp via an OAuth-authenticated request', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      balance: { balance: 42.5 },
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    const remaining = await gateway.getReportedSpend('ramp-budget-research');

    expect(remaining).toBe(42.5);
    const balanceCall = fetchFn.mock.calls.find(([url]) => !url.toString().includes('/token'));
    expect(balanceCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
  });

  it('throws when the balance request fails, without falling back silently', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      balance: { error: 'not_found' },
      balanceStatus: 404,
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await expect(gateway.getReportedSpend('ramp-budget-research')).rejects.toThrow(/404/);
  });

  it('throws when the OAuth exchange fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await expect(gateway.getReportedSpend('ramp-budget-research')).rejects.toThrow(/401/);
  });

  it('writes receipts locally rather than to a real Ramp endpoint', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      balance: { balance: 10 },
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await gateway.reportTaskUsage(receipt());

    const persisted = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    expect(persisted.receipts).toHaveLength(1);
    // Writing a receipt never calls the network — only reads do.
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ramp-api-gateway.test.ts`
Expected: FAIL — `Cannot find module '../src/ramp-api-gateway.js'`.

- [ ] **Step 4: Implement `src/ramp-api-gateway.ts`**

```ts
import { LocalReceiptStore, type RampGateway, type TaskReceipt } from './store.js';
import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';

export interface RampApiGatewayConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/**
 * Reads real Ramp spend-limit balances via OAuth. Writes stay local
 * (LocalReceiptStore) since a real Ramp financial write requires Vault
 * card issuance and PCI approval this project doesn't have — see
 * docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md.
 */
export class RampApiGateway implements RampGateway {
  private oauth: RampOAuthClient;
  private receipts: LocalReceiptStore;

  constructor(
    private config: RampApiGatewayConfig,
    receiptStorePath: string,
    private fetchFn: HttpFetch = fetch
  ) {
    this.oauth = new RampOAuthClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenUrl: `${config.baseUrl}/developer/v1/token`,
      },
      fetchFn
    );
    this.receipts = new LocalReceiptStore(receiptStorePath);
  }

  async getReportedSpend(rampBudgetId: string): Promise<number> {
    const token = await this.oauth.getAccessToken();
    const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/limits/${rampBudgetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Ramp balance request for "${rampBudgetId}" failed with status ${response.status}`);
    }

    // Placeholder shape ({ balance: number }) until docs/ramp-api-notes.md
    // confirms Ramp's real spend-limit response field names.
    const body = (await response.json()) as { balance: number };
    return body.balance;
  }

  async reportTaskUsage(receipt: TaskReceipt): Promise<void> {
    this.receipts.addReceipt(receipt);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ramp-api-gateway.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ramp-api-gateway.ts tests/ramp-api-gateway.test.ts
git commit -m "Add RampApiGateway: real balance reads, local receipt writes"
```

---

### Task 8: Config additions — `ramp_limit_id`

**Files:**
- Modify: `src/config.ts`
- Modify: `specspend.yaml`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RampBudgetConfig.rampLimitId?: string`, used by `createRampGateway()`/`RampApiGateway` callers (Task 9) to know which real Ramp resource ID to query per budget.

- [ ] **Step 1: Update `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads Ramp budgets and task credential policy', () => {
    const config = loadConfig('specspend.yaml');
    expect(config.team).toBe('agent-platform');
    expect(config.rampEntityId).toBe('ramp-entity-demo');
    expect(config.budgets.research).toEqual({
      rampBudgetId: 'ramp-budget-research',
      rampLimitId: 'ramp-limit-research',
      monthlyLimit: 100,
      maxTaskAllowance: 10,
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      fallbackModel: 'claude-haiku-4-5-20251001',
      onLimit: 'deny',
      taskTtlSeconds: 900,
      costCenter: 'AI compute',
    });
  });

  it('throws for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `rampLimitId` is `undefined` in the parsed config, so `toEqual` fails.

- [ ] **Step 3: Add `ramp_limit_id` to `specspend.yaml`**

Update both budget entries (research and support):

```yaml
team: agent-platform
ramp_entity_id: ramp-entity-demo
budgets:
  research:
    ramp_budget_id: ramp-budget-research
    ramp_limit_id: ramp-limit-research
    monthly_limit: 100
    max_task_allowance: 10
    allowed_models:
      - claude-sonnet-5
      - claude-haiku-4-5-20251001
    fallback_model: claude-haiku-4-5-20251001
    on_limit: deny
    task_ttl_seconds: 900
    cost_center: AI compute
  support:
    ramp_budget_id: ramp-budget-support
    ramp_limit_id: ramp-limit-support
    monthly_limit: 250
    max_task_allowance: 5
    allowed_models:
      - claude-sonnet-5
      - claude-haiku-4-5-20251001
    fallback_model: claude-haiku-4-5-20251001
    on_limit: degrade
    task_ttl_seconds: 600
    cost_center: Support automation
```

- [ ] **Step 4: Update `src/config.ts`**

```ts
import fs from 'node:fs';
import yaml from 'js-yaml';

export type LimitBehavior = 'degrade' | 'request-approval' | 'deny';

export interface RampBudgetConfig {
  rampBudgetId: string;
  rampLimitId?: string;
  monthlyLimit: number;
  maxTaskAllowance: number;
  allowedModels: string[];
  fallbackModel: string;
  onLimit: LimitBehavior;
  taskTtlSeconds: number;
  costCenter: string;
}

export interface SpecSpendConfig {
  team: string;
  rampEntityId: string;
  budgets: Record<string, RampBudgetConfig>;
}

interface RawBudget {
  ramp_budget_id: string;
  ramp_limit_id?: string;
  monthly_limit: number;
  max_task_allowance: number;
  allowed_models: string[];
  fallback_model: string;
  on_limit: LimitBehavior;
  task_ttl_seconds: number;
  cost_center: string;
}

interface RawConfig {
  team: string;
  ramp_entity_id: string;
  budgets: Record<string, RawBudget>;
}

export function loadConfig(filePath: string): SpecSpendConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as RawConfig;
  if (!raw?.team || !raw.ramp_entity_id || !raw.budgets) {
    throw new Error('Config must define team, ramp_entity_id, and budgets');
  }

  const budgets: Record<string, RampBudgetConfig> = {};
  for (const [name, budget] of Object.entries(raw.budgets)) {
    if (budget.monthly_limit <= 0 || budget.max_task_allowance <= 0) {
      throw new Error(`Budget "${name}" limits must be positive`);
    }
    if (budget.max_task_allowance > budget.monthly_limit) {
      throw new Error(`Budget "${name}" max_task_allowance cannot exceed monthly_limit`);
    }
    if (!budget.allowed_models.includes(budget.fallback_model)) {
      throw new Error(`Budget "${name}" fallback_model must be in allowed_models`);
    }
    budgets[name] = {
      rampBudgetId: budget.ramp_budget_id,
      rampLimitId: budget.ramp_limit_id,
      monthlyLimit: budget.monthly_limit,
      maxTaskAllowance: budget.max_task_allowance,
      allowedModels: budget.allowed_models,
      fallbackModel: budget.fallback_model,
      onLimit: budget.on_limit,
      taskTtlSeconds: budget.task_ttl_seconds,
      costCenter: budget.cost_center,
    };
  }

  return { team: raw.team, rampEntityId: raw.ramp_entity_id, budgets };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all test files pass (the `research` budget's `rampLimitId` addition doesn't affect any other test's assertions, since none of them use `toEqual` on the full budget object except `config.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts specspend.yaml tests/config.test.ts
git commit -m "Add ramp_limit_id to budget config for real Ramp resource lookup"
```

---

### Task 9: Gateway factory, wiring, and docs

**Files:**
- Modify: `src/runtime.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `RampApiGateway` (Task 7), `MockRampGateway` (Task 3), `RampBudgetConfig.rampLimitId` (Task 8).
- Produces: `createRampGateway(storePath: string): RampGateway`, used by `SpecSpendRuntime`'s constructor when no explicit `ramp` override is passed in (tests keep injecting `MockRampGateway` directly, unaffected by this change).

- [ ] **Step 1: Add `createRampGateway` to `src/runtime.ts`**

```ts
import { loadConfig, type RampBudgetConfig, type SpecSpendConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { BudgetRouter } from './router.js';
import { MockRampGateway, type RampGateway } from './store.js';
import { RampApiGateway } from './ramp-api-gateway.js';

export function createRampGateway(storePath: string): RampGateway {
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;

  if (clientId && clientSecret) {
    const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://sandbox-api.ramp.com';
    console.log(`[ramp] using RampApiGateway (${baseUrl})`);
    return new RampApiGateway({ clientId, clientSecret, baseUrl }, storePath);
  }

  console.log('[ramp] RAMP_CLIENT_ID/RAMP_CLIENT_SECRET not set, using MockRampGateway');
  return new MockRampGateway(storePath);
}

export class SpecSpendRuntime {
  readonly config: SpecSpendConfig;
  readonly ramp: RampGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(configPath: string, storePath: string, ramp?: RampGateway) {
    this.config = loadConfig(configPath);
    this.ramp = ramp ?? createRampGateway(storePath);
    this.authorizations = new TaskAuthorizationManager(this.config, this.ramp);
  }

  getBudget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }
}
```

- [ ] **Step 2: Verify the factory falls back to the mock gateway with no env vars set**

Run: `npx vitest run tests/runtime.test.ts`
Expected: PASS (2 tests) — these tests construct `SpecSpendRuntime` without an explicit `ramp` argument, so they now exercise `createRampGateway()`; with no `RAMP_CLIENT_ID` set in the test environment, it should fall back to `MockRampGateway` and behave exactly as before.

- [ ] **Step 3: Verify the factory picks the real gateway when env vars are set**

Run: `RAMP_CLIENT_ID=x RAMP_CLIENT_SECRET=y node -e "
process.env.RAMP_CLIENT_ID='x'; process.env.RAMP_CLIENT_SECRET='y';
import('./dist/src/runtime.js').then(({ createRampGateway }) => {
  const gw = createRampGateway('/tmp/specspend-smoke.json');
  console.log(gw.constructor.name);
});
"`

First run `npm run build` if `dist/` isn't already up to date. Expected output: `RampApiGateway`.

- [ ] **Step 4: Update `README.md`**

Replace the "Run it" section with:

```markdown
## Run it

```bash
npm install
cp .env.example .env   # paste in ANTHROPIC_API_KEY and, once you have them, RAMP_CLIENT_ID/RAMP_CLIENT_SECRET
npm test
npm run build

npm run demo
```

The demo uses `specspend.yaml` and writes settled task receipts to
`.specspend/ramp.json`. Task authorization reads its remaining-budget number
from `RampApiGateway` if `RAMP_CLIENT_ID`/`RAMP_CLIENT_SECRET` are set in
`.env`, otherwise from the local `MockRampGateway` — see `src/runtime.ts`'s
`createRampGateway()`. Either way, task receipts are written locally; a real
Ramp write requires Vault card issuance and PCI approval this project
doesn't have yet (see `docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`).
```

Update the "Runtime API" code sample to reflect the now-async calls:

```markdown
## Runtime API

```ts
const runtime = new SpecSpendRuntime('specspend.yaml', '.specspend/ramp.json');

const task = await runtime.authorizations.authorizeTask({
  budget: 'research',
  taskId: 'review-pr-418',
  task: 'Review PR 418 with two specialist agents',
  allowance: 1.5,
});

const child = runtime.authorizations.delegate(
  task.credential,
  'security-reviewer',
  0.4,
);

await client.run({
  credential: child.credential,
  estimatedInputTokens: 4_000,
  maxTokens: 1_000,
  messages,
});

const receipt = await runtime.authorizations.settleTask(
  task.authorization.authorizationId,
);
```
```

- [ ] **Step 5: Run the full suite and build one more time**

Run: `npm test && npm run build`
Expected: all test files pass, `tsc` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts README.md
git commit -m "Add Ramp gateway factory with env-based credential selection"
```

---

## Plan self-review notes

- **Spec coverage:** `.env` credential loading (Task 1), the docs-research known-unknown gate (Tasks 2 and 7 Step 1), `RampOAuthClient` (Task 6), `RampApiGateway` real-read/mocked-write split (Task 7), `LocalReceiptStore` extraction to avoid duplicating receipt logic (Task 3), `ramp_limit_id` config (Task 8), and the startup-time gateway factory (Task 9) all trace directly to sections of `docs/superpowers/specs/2026-07-17-ramp-api-gateway-design.md`.
- **Placeholder scan:** no TBD/TODO markers. The one deliberately-unresolved item (Ramp's real response field names) is handled as a documented, testable placeholder shape, not a vague "add real parsing later."
- **Type consistency:** `RampGateway`'s two methods return `Promise<number>`/`Promise<void>` from Task 3 onward and every later task's code matches that; `TaskAuthorizationManager.getBudgetRemaining`/`authorizeTask`/`settleTask` return `Promise<...>` from Task 4 onward and `handlers.ts`/`mcp-server.ts`/`demo/run-demo.ts`/tests await them consistently; `RampBudgetConfig.rampLimitId` is optional (`string | undefined`) everywhere it appears.
- **Scope check:** this is one coherent unit of work — the async conversion (Tasks 3–5) is a prerequisite the real adapter (Tasks 6–7) can't avoid, not a separate subsystem, so it isn't split into its own plan.
