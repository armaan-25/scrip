# SpendSpec MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-process TypeScript/Node MVP of SpendSpec — a config-driven team/project/feature budget hierarchy, an MCP server exposing 4 budget-visibility tools, a real-Anthropic-SDK proxy that enforces per-task budget leases, and a demo harness that reproduces the spec's Best Builder Cup transcript.

**Architecture:** A `SpendSpecRuntime` object wires together a YAML-loaded config, a JSON-file-backed mock Ramp store, an in-memory lease manager, and a budget-driven model router. Pure handler functions sit behind the MCP tool registrations so they're testable without a transport. `SpendSpecClient.run()` is the enforcement layer: it reserves a lease, calls the real Anthropic API, computes actual cost from real token usage against a ported price table, and applies the feature's `on_limit` policy before releasing the lease and writing a receipt.

**Tech Stack:** TypeScript (Node 20+, ESM/`NodeNext` modules), `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `js-yaml`, `zod`, `vitest` for tests, `tsx` for running TS scripts directly.

## Global Constraints

- Single Node process for the whole MVP — no separate services, no Python runtime (per design doc, agentopt is a reference for interfaces/data only).
- MCP server exposes exactly these 4 tools and no others: `get_spend_policy`, `estimate_spend`, `request_more_budget`, `record_usage`.
- Price table is ported from `~/Desktop/Projects/agentopt/model_price.json` (`{model: {input_price, output_price}}`, dollars per 1,000,000 tokens), not hand-typed from scratch.
- Demo models are the real callable Anthropic model IDs: `claude-sonnet-5` and `claude-haiku-4-5-20251001`.
- Out of scope: real Ramp API, dashboards, approval-flow UI beyond a logged pending state, the agentopt BERT router, real multi-agent orchestration frameworks, config hot-reload.
- The demo harness (`demo/run-demo.ts`) makes real, billed Anthropic API calls — it is run manually, never in CI or as part of the automated test suite.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: an npm project with `npm run build`, `npm test`, `npm run demo`, `npm run mcp-server` scripts that later tasks rely on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "spendspec",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "mcp-server": "tsx bin/mcp-server.ts",
    "demo": "tsx demo/run-demo.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1",
    "@modelcontextprotocol/sdk": "^1.7.0",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "bin", "demo", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.spendspec/
.env
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 6: Verify the test runner works with zero tests**

Run: `npm test`
Expected: vitest reports "No test files found" or exits 0 — confirms the toolchain is wired before any real code exists.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "Scaffold SpendSpec TypeScript project"
```

---

### Task 2: Config layer

**Files:**
- Create: `src/config.ts`
- Create: `spendspec.yaml`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first domain module).
- Produces: `FeatureConfig`, `ProjectConfig`, `SpendConfig` types and `loadConfig(filePath: string): SpendConfig`, used by every later task.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses the demo spendspec.yaml into typed config', () => {
    const config = loadConfig('spendspec.yaml');

    expect(config.team).toBe('hackathon-demo');
    expect(config.projects['research-agent'].monthlyBudget).toBe(2);
    expect(config.projects['research-agent'].features['default']).toEqual({
      monthlyBudget: 2,
      maxPerRequest: 2.0,
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      fallbackModel: 'claude-haiku-4-5-20251001',
      onLimit: 'degrade',
    });
  });

  it('throws a clear error for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'` (file doesn't exist yet).

- [ ] **Step 3: Create `spendspec.yaml`**

```yaml
team: hackathon-demo
projects:
  support-agent:
    monthly_budget: 10
    warning_threshold: 0.8
    features:
      default:
        monthly_budget: 10
        max_per_request: 1.00
        allowed_models:
          - claude-sonnet-5
          - claude-haiku-4-5-20251001
        fallback_model: claude-haiku-4-5-20251001
        on_limit: degrade
  research-agent:
    monthly_budget: 2
    warning_threshold: 0.8
    features:
      default:
        monthly_budget: 2
        max_per_request: 2.00
        allowed_models:
          - claude-sonnet-5
          - claude-haiku-4-5-20251001
        fallback_model: claude-haiku-4-5-20251001
        on_limit: degrade
```

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import fs from 'node:fs';
import yaml from 'js-yaml';

export interface FeatureConfig {
  monthlyBudget: number;
  maxPerRequest: number;
  allowedModels: string[];
  fallbackModel: string;
  onLimit: 'degrade' | 'request-approval' | 'throw';
}

export interface ProjectConfig {
  monthlyBudget: number;
  warningThreshold: number;
  features: Record<string, FeatureConfig>;
}

export interface SpendConfig {
  team: string;
  projects: Record<string, ProjectConfig>;
}

interface RawFeature {
  monthly_budget: number;
  max_per_request: number;
  allowed_models: string[];
  fallback_model: string;
  on_limit: 'degrade' | 'request-approval' | 'throw';
}

interface RawProject {
  monthly_budget: number;
  warning_threshold: number;
  features: Record<string, RawFeature>;
}

interface RawConfig {
  team: string;
  projects: Record<string, RawProject>;
}

export function loadConfig(filePath: string): SpendConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as RawConfig;

  const projects: Record<string, ProjectConfig> = {};
  for (const [projectName, rawProject] of Object.entries(raw.projects)) {
    const features: Record<string, FeatureConfig> = {};
    for (const [featureName, rawFeature] of Object.entries(rawProject.features)) {
      features[featureName] = {
        monthlyBudget: rawFeature.monthly_budget,
        maxPerRequest: rawFeature.max_per_request,
        allowedModels: rawFeature.allowed_models,
        fallbackModel: rawFeature.fallback_model,
        onLimit: rawFeature.on_limit,
      };
    }
    projects[projectName] = {
      monthlyBudget: rawProject.monthly_budget,
      warningThreshold: rawProject.warning_threshold,
      features,
    };
  }

  return { team: raw.team, projects };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts spendspec.yaml tests/config.test.ts
git commit -m "Add config layer for team/project/feature budget hierarchy"
```

---

### Task 3: Mock Ramp store

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Receipt` type and `MockRampStore` class with `addReceipt(receipt: Receipt): void` and `getSpend(project: string, feature: string, sinceMonth?: string): number`, used by `LeaseManager` (Task 6) and `SpendSpecClient` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `tests/store.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockRampStore, type Receipt } from '../src/store.js';

let tmpFile: string;

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    team: 'hackathon-demo',
    project: 'research-agent',
    feature: 'default',
    task: 'test task',
    authorized: 1.0,
    actual: 0.5,
    model: 'claude-haiku-4-5-20251001',
    costCenter: 'Product COGS',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-')), 'store.json');
});

afterEach(() => {
  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
});

describe('MockRampStore', () => {
  it('creates an empty store file if none exists', () => {
    const store = new MockRampStore(tmpFile);
    expect(store.getSpend('research-agent', 'default')).toBe(0);
  });

  it('sums actual spend for matching project/feature this month', () => {
    const store = new MockRampStore(tmpFile);
    store.addReceipt(makeReceipt({ actual: 0.3 }));
    store.addReceipt(makeReceipt({ actual: 0.2 }));
    store.addReceipt(makeReceipt({ project: 'support-agent', actual: 5.0 }));

    expect(store.getSpend('research-agent', 'default')).toBeCloseTo(0.5);
    expect(store.getSpend('support-agent', 'default')).toBeCloseTo(5.0);
  });

  it('excludes receipts from a different month', () => {
    const store = new MockRampStore(tmpFile);
    store.addReceipt(makeReceipt({ actual: 1.0, timestamp: '2020-01-15T00:00:00.000Z' }));

    expect(store.getSpend('research-agent', 'default', '2026-07')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `Cannot find module '../src/store.js'`.

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface Receipt {
  team: string;
  project: string;
  feature: string;
  task: string;
  authorized: number;
  actual: number;
  model: string;
  costCenter: string;
  timestamp: string;
}

interface StoreData {
  receipts: Receipt[];
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

export class MockRampStore {
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

  addReceipt(receipt: Receipt): void {
    const data = this.load();
    data.receipts.push(receipt);
    this.save(data);
    console.log(
      `[receipt] team=${receipt.team} project=${receipt.project} feature=${receipt.feature} ` +
        `task="${receipt.task}" authorized=$${receipt.authorized.toFixed(4)} actual=$${receipt.actual.toFixed(4)} ` +
        `model=${receipt.model} costCenter=${receipt.costCenter}`
    );
  }

  getSpend(project: string, feature: string, sinceMonth: string = currentMonth()): number {
    const data = this.load();
    return data.receipts
      .filter((r) => r.project === project && r.feature === feature && r.timestamp.startsWith(sinceMonth))
      .reduce((sum, r) => sum + r.actual, 0);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "Add mock Ramp store for receipts and spend-to-date"
```

---

### Task 4: Price table port + cost math

**Files:**
- Create: `scripts/port-price-table.mjs`
- Create: `src/pricing/model_price.json` (generated by the script, then committed)
- Create: `src/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ModelPrice` type, `getModelPrice(model: string): ModelPrice`, `computeCost(model: string, inputTokens: number, outputTokens: number): number`, used by `BudgetRouter` (Task 5) and `SpendSpecClient` (Task 9).

- [ ] **Step 1: Write the port script `scripts/port-price-table.mjs`**

```js
import fs from 'node:fs';

const sourcePath = process.env.AGENTOPT_PRICE_PATH || `${process.env.HOME}/Desktop/Projects/agentopt/model_price.json`;
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));

const ported = {};
for (const [key, value] of Object.entries(source)) {
  const normalized = key.startsWith('anthropic/')
    ? key.slice('anthropic/'.length).replaceAll('.', '-')
    : key;
  ported[normalized] = { inputPrice: value.input_price, outputPrice: value.output_price };
}

// Demo models use exact Anthropic API model IDs, which don't match agentopt's
// OpenRouter-style slugs. Add explicit entries at the same published per-1M-token rates.
ported['claude-sonnet-5'] = { inputPrice: 3.0, outputPrice: 15.0 };
ported['claude-haiku-4-5-20251001'] = { inputPrice: 1.0, outputPrice: 5.0 };

fs.writeFileSync(
  new URL('../src/pricing/model_price.json', import.meta.url),
  JSON.stringify(ported, null, 2) + '\n'
);
console.log(`Wrote ${Object.keys(ported).length} price entries.`);
```

- [ ] **Step 2: Run the script to generate the price table**

Run: `mkdir -p src/pricing && node scripts/port-price-table.mjs`
Expected: `Wrote 250 price entries.` (248 ported + 2 demo overrides) and `src/pricing/model_price.json` created.

If `~/Desktop/Projects/agentopt/model_price.json` isn't present on the machine running this, set `AGENTOPT_PRICE_PATH` to wherever it lives, or skip straight to Step 2b.

- [ ] **Step 2b: Verify the demo models are present**

Run: `node -e "const p = require('./src/pricing/model_price.json'); console.log(p['claude-sonnet-5'], p['claude-haiku-4-5-20251001'])"`
Expected: `{ inputPrice: 3, outputPrice: 15 } { inputPrice: 1, outputPrice: 5 }`

- [ ] **Step 3: Write the failing test**

Create `tests/pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeCost, getModelPrice } from '../src/pricing.js';

describe('pricing', () => {
  it('returns known prices for the demo models', () => {
    expect(getModelPrice('claude-sonnet-5')).toEqual({ inputPrice: 3.0, outputPrice: 15.0 });
    expect(getModelPrice('claude-haiku-4-5-20251001')).toEqual({ inputPrice: 1.0, outputPrice: 5.0 });
  });

  it('throws for an unknown model', () => {
    expect(() => getModelPrice('not-a-real-model')).toThrow();
  });

  it('computes cost from token counts at $/1M-token rates', () => {
    // 1000 input tokens + 500 output tokens on claude-sonnet-5 ($3/$15 per 1M)
    const cost = computeCost('claude-sonnet-5', 1000, 500);
    expect(cost).toBeCloseTo((1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/pricing.test.ts`
Expected: FAIL — `Cannot find module '../src/pricing.js'`.

- [ ] **Step 5: Implement `src/pricing.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ModelPrice {
  inputPrice: number; // dollars per 1,000,000 input tokens
  outputPrice: number; // dollars per 1,000,000 output tokens
}

const priceTable: Record<string, ModelPrice> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'pricing', 'model_price.json'), 'utf-8')
);

export function getModelPrice(model: string): ModelPrice {
  const price = priceTable[model];
  if (!price) {
    throw new Error(`No price entry for model "${model}"`);
  }
  return price;
}

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = getModelPrice(model);
  return (inputTokens / 1_000_000) * price.inputPrice + (outputTokens / 1_000_000) * price.outputPrice;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/pricing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/port-price-table.mjs src/pricing/model_price.json src/pricing.ts tests/pricing.test.ts
git commit -m "Port agentopt price table and add cost computation"
```

---

### Task 5: BudgetRouter

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

**Interfaces:**
- Consumes: `getModelPrice` from `src/pricing.ts` (Task 4).
- Produces: `RouteContext` type and `BudgetRouter` class with `route(ctx: RouteContext): string`, used by `SpendSpecClient` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `tests/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BudgetRouter } from '../src/router.js';

describe('BudgetRouter', () => {
  const router = new BudgetRouter();
  const allowedModels = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const fallbackModel = 'claude-haiku-4-5-20251001';

  it('picks the premium model when remaining budget comfortably covers the scaled estimate', () => {
    // taskEstimate priced at the fallback (haiku, $5/1M out); sonnet is 3x haiku's output price
    const model = router.route({
      remainingBudget: 1.0,
      taskEstimate: 0.1,
      allowedModels,
      fallbackModel,
    });
    expect(model).toBe('claude-sonnet-5');
  });

  it('degrades to the fallback model when the scaled estimate would exceed remaining budget', () => {
    const model = router.route({
      remainingBudget: 0.2,
      taskEstimate: 0.1,
      allowedModels,
      fallbackModel,
    });
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('always returns the fallback model when it is the only allowed model', () => {
    const model = router.route({
      remainingBudget: 100,
      taskEstimate: 0.01,
      allowedModels: [fallbackModel],
      fallbackModel,
    });
    expect(model).toBe(fallbackModel);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/router.test.ts`
Expected: FAIL — `Cannot find module '../src/router.js'`.

- [ ] **Step 3: Implement `src/router.ts`**

```ts
import { getModelPrice } from './pricing.js';

export interface RouteContext {
  remainingBudget: number;
  taskEstimate: number;
  allowedModels: string[];
  fallbackModel: string;
}

export class BudgetRouter {
  route(ctx: RouteContext): string {
    const { remainingBudget, taskEstimate, allowedModels, fallbackModel } = ctx;
    const fallbackPrice = getModelPrice(fallbackModel).outputPrice;

    const byPriceDesc = [...allowedModels].sort(
      (a, b) => getModelPrice(b).outputPrice - getModelPrice(a).outputPrice
    );

    for (const model of byPriceDesc) {
      const modelPrice = getModelPrice(model).outputPrice;
      const scaledEstimate = taskEstimate * (modelPrice / fallbackPrice);
      if (scaledEstimate <= remainingBudget) {
        return model;
      }
    }
    return fallbackModel;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "Add budget-driven model router"
```

---

### Task 6: LeaseManager

**Files:**
- Create: `src/lease.ts`
- Test: `tests/lease.test.ts`

**Interfaces:**
- Consumes: `SpendConfig` (Task 2), `MockRampStore` (Task 3).
- Produces: `Lease` type, `SpendLimitExceededError` class, `LeaseManager` class with `getRemainingBudget(project, feature): number`, `reserve(project, feature, amount, ttlMs?): Lease`, `getLease(leaseId): Lease`, `recordSpend(leaseId, actualCost): void`, `release(leaseId): number`, `grantAdditionalBudget(project, feature, amount): void` — used by `handlers.ts`/`mcp-server.ts` (Task 8) and `SpendSpecClient` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `tests/lease.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type SpendConfig } from '../src/config.js';
import { LeaseManager, SpendLimitExceededError } from '../src/lease.js';
import { MockRampStore } from '../src/store.js';

let tmpDir: string;
let config: SpendConfig;
let store: MockRampStore;
let leaseManager: LeaseManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-lease-'));
  config = loadConfig('spendspec.yaml');
  store = new MockRampStore(path.join(tmpDir, 'store.json'));
  leaseManager = new LeaseManager(config, store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LeaseManager', () => {
  it('reports the full monthly budget as remaining when nothing has been spent or reserved', () => {
    expect(leaseManager.getRemainingBudget('research-agent', 'default')).toBe(2);
  });

  it('reduces remaining budget by active reservations', () => {
    leaseManager.reserve('research-agent', 'default', 0.5);
    expect(leaseManager.getRemainingBudget('research-agent', 'default')).toBeCloseTo(1.5);
  });

  it('throws when reserving more than remaining budget', () => {
    expect(() => leaseManager.reserve('research-agent', 'default', 3)).toThrow(SpendLimitExceededError);
  });

  it('releases unused reservation back to the budget', () => {
    const lease = leaseManager.reserve('research-agent', 'default', 1.0);
    leaseManager.recordSpend(lease.leaseId, 0.4);
    const returned = leaseManager.release(lease.leaseId);

    expect(returned).toBeCloseTo(0.6);
    expect(leaseManager.getRemainingBudget('research-agent', 'default')).toBeCloseTo(2); // reservation released, nothing recorded to the store yet
  });

  it('grantAdditionalBudget increases remaining budget for that project/feature', () => {
    leaseManager.grantAdditionalBudget('research-agent', 'default', 1.0);
    expect(leaseManager.getRemainingBudget('research-agent', 'default')).toBeCloseTo(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lease.test.ts`
Expected: FAIL — `Cannot find module '../src/lease.js'`.

- [ ] **Step 3: Implement `src/lease.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { SpendConfig } from './config.js';
import type { MockRampStore } from './store.js';

export interface Lease {
  leaseId: string;
  project: string;
  feature: string;
  reservedAmount: number;
  spent: number;
  released: boolean;
  expiresAt: string;
}

export class SpendLimitExceededError extends Error {}

export class LeaseManager {
  private leases = new Map<string, Lease>();
  private grants = new Map<string, number>();

  constructor(private config: SpendConfig, private store: MockRampStore) {}

  private key(project: string, feature: string): string {
    return `${project}:${feature}`;
  }

  private featureBudget(project: string, feature: string): number {
    const projectConfig = this.config.projects[project];
    if (!projectConfig) throw new Error(`Unknown project "${project}"`);
    const featureConfig = projectConfig.features[feature];
    if (!featureConfig) throw new Error(`Unknown feature "${feature}" in project "${project}"`);
    return featureConfig.monthlyBudget;
  }

  grantAdditionalBudget(project: string, feature: string, amount: number): void {
    const key = this.key(project, feature);
    this.grants.set(key, (this.grants.get(key) ?? 0) + amount);
  }

  getRemainingBudget(project: string, feature: string): number {
    const budget = this.featureBudget(project, feature) + (this.grants.get(this.key(project, feature)) ?? 0);
    const spent = this.store.getSpend(project, feature);
    const reserved = [...this.leases.values()]
      .filter((l) => l.project === project && l.feature === feature && !l.released)
      .reduce((sum, l) => sum + l.reservedAmount, 0);
    return budget - spent - reserved;
  }

  reserve(project: string, feature: string, amount: number, ttlMs = 5 * 60 * 1000): Lease {
    const remaining = this.getRemainingBudget(project, feature);
    if (amount > remaining) {
      throw new SpendLimitExceededError(
        `Cannot reserve $${amount.toFixed(4)} for ${project}/${feature}: only $${remaining.toFixed(4)} remaining`
      );
    }
    const lease: Lease = {
      leaseId: randomUUID(),
      project,
      feature,
      reservedAmount: amount,
      spent: 0,
      released: false,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  getLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`Unknown lease "${leaseId}"`);
    return lease;
  }

  recordSpend(leaseId: string, actualCost: number): void {
    const lease = this.getLease(leaseId);
    lease.spent = actualCost;
  }

  release(leaseId: string): number {
    const lease = this.getLease(leaseId);
    lease.released = true;
    return lease.reservedAmount - lease.spent;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lease.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lease.ts tests/lease.test.ts
git commit -m "Add per-task budget lease manager"
```

---

### Task 7: Runtime wiring

**Files:**
- Create: `src/runtime.ts`
- Test: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`SpendConfig` (Task 2), `MockRampStore` (Task 3), `LeaseManager` (Task 6), `BudgetRouter` (Task 5).
- Produces: `SpendSpecRuntime` class with public readonly `config`, `store`, `leaseManager`, `router`, and method `getFeatureConfig(project: string, feature: string): { projectConfig: ProjectConfig; featureConfig: FeatureConfig }` — used by `handlers.ts` (Task 8) and `SpendSpecClient` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `tests/runtime.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendSpecRuntime } from '../src/runtime.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-runtime-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SpendSpecRuntime', () => {
  it('wires config, store, leaseManager, and router together', () => {
    const runtime = new SpendSpecRuntime('spendspec.yaml', path.join(tmpDir, 'store.json'));

    expect(runtime.config.team).toBe('hackathon-demo');
    expect(runtime.leaseManager.getRemainingBudget('research-agent', 'default')).toBe(2);
    expect(runtime.router.route({
      remainingBudget: 10,
      taskEstimate: 0.01,
      allowedModels: ['claude-sonnet-5'],
      fallbackModel: 'claude-sonnet-5',
    })).toBe('claude-sonnet-5');
  });

  it('getFeatureConfig throws for an unknown project', () => {
    const runtime = new SpendSpecRuntime('spendspec.yaml', path.join(tmpDir, 'store.json'));
    expect(() => runtime.getFeatureConfig('not-a-project', 'default')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime.js'`.

- [ ] **Step 3: Implement `src/runtime.ts`**

```ts
import { loadConfig, type FeatureConfig, type ProjectConfig, type SpendConfig } from './config.js';
import { MockRampStore } from './store.js';
import { LeaseManager } from './lease.js';
import { BudgetRouter } from './router.js';

export class SpendSpecRuntime {
  readonly config: SpendConfig;
  readonly store: MockRampStore;
  readonly leaseManager: LeaseManager;
  readonly router: BudgetRouter;

  constructor(configPath: string, storePath: string) {
    this.config = loadConfig(configPath);
    this.store = new MockRampStore(storePath);
    this.leaseManager = new LeaseManager(this.config, this.store);
    this.router = new BudgetRouter();
  }

  getFeatureConfig(project: string, feature: string): { projectConfig: ProjectConfig; featureConfig: FeatureConfig } {
    const projectConfig = this.config.projects[project];
    if (!projectConfig) throw new Error(`Unknown project "${project}"`);
    const featureConfig = projectConfig.features[feature];
    if (!featureConfig) throw new Error(`Unknown feature "${feature}" in project "${project}"`);
    return { projectConfig, featureConfig };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "Add SpendSpecRuntime wiring config, store, lease manager, and router"
```

---

### Task 8: Handlers + MCP server

**Files:**
- Create: `src/handlers.ts`
- Create: `src/mcp-server.ts`
- Create: `bin/mcp-server.ts`
- Test: `tests/handlers.test.ts`

**Interfaces:**
- Consumes: `SpendSpecRuntime` (Task 7), `computeCost` (Task 4).
- Produces: `getSpendPolicy`, `estimateSpend`, `requestMoreBudget`, `recordUsage` pure functions (used directly by `SpendSpecClient` in Task 9 for the `request-approval` path), plus `createMcpServer(runtime): McpServer` and `startMcpServer(runtime): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/handlers.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendSpecRuntime } from '../src/runtime.js';
import { estimateSpend, getSpendPolicy, recordUsage, requestMoreBudget } from '../src/handlers.js';

let tmpDir: string;
let runtime: SpendSpecRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-handlers-'));
  runtime = new SpendSpecRuntime('spendspec.yaml', path.join(tmpDir, 'store.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getSpendPolicy', () => {
  it('returns remaining budget and task policy for a project/feature', () => {
    const policy = getSpendPolicy(runtime, 'research-agent', 'default');
    expect(policy.projectBudget).toEqual({ limit: 2, spent: 0, remaining: 2 });
    expect(policy.taskPolicy.allowedModels).toEqual(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(policy.taskPolicy.fallbackModel).toBe('claude-haiku-4-5-20251001');
  });
});

describe('estimateSpend', () => {
  it('multiplies per-call cost by numCalls', () => {
    const estimate = estimateSpend(runtime, {
      project: 'research-agent',
      feature: 'default',
      model: 'claude-haiku-4-5-20251001',
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 500,
      numCalls: 5,
    });
    const perCall = (1000 / 1_000_000) * 1.0 + (500 / 1_000_000) * 5.0;
    expect(estimate).toBeCloseTo(perCall * 5);
  });
});

describe('requestMoreBudget', () => {
  it('auto-approves amounts under the ceiling and grants budget', () => {
    const result = requestMoreBudget(runtime, 'research-agent', 'default', 0.5, 'overrun');
    expect(result).toEqual({ approved: true, status: 'approved' });
    expect(runtime.leaseManager.getRemainingBudget('research-agent', 'default')).toBeCloseTo(2.5);
  });

  it('marks amounts over the ceiling as pending approval without granting', () => {
    const result = requestMoreBudget(runtime, 'research-agent', 'default', 5, 'big overrun');
    expect(result).toEqual({ approved: false, status: 'pending_approval' });
    expect(runtime.leaseManager.getRemainingBudget('research-agent', 'default')).toBe(2);
  });
});

describe('recordUsage', () => {
  it('writes a receipt and releases the lease', () => {
    const lease = runtime.leaseManager.reserve('research-agent', 'default', 1.0);
    recordUsage(runtime, {
      leaseId: lease.leaseId,
      team: runtime.config.team,
      task: 'test task',
      actualCost: 0.4,
      model: 'claude-haiku-4-5-20251001',
      costCenter: 'Product COGS',
    });

    expect(runtime.store.getSpend('research-agent', 'default')).toBeCloseTo(0.4);
    expect(runtime.leaseManager.getRemainingBudget('research-agent', 'default')).toBeCloseTo(1.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers.test.ts`
Expected: FAIL — `Cannot find module '../src/handlers.js'`.

- [ ] **Step 3: Implement `src/handlers.ts`**

```ts
import type { SpendSpecRuntime } from './runtime.js';
import { computeCost } from './pricing.js';

export interface SpendPolicyResult {
  projectBudget: { limit: number; spent: number; remaining: number };
  taskPolicy: {
    maxPerRequest: number;
    allowedModels: string[];
    fallbackModel: string;
    onLimit: string;
  };
}

export function getSpendPolicy(runtime: SpendSpecRuntime, project: string, feature: string): SpendPolicyResult {
  const { featureConfig } = runtime.getFeatureConfig(project, feature);
  const spent = runtime.store.getSpend(project, feature);
  const remaining = runtime.leaseManager.getRemainingBudget(project, feature);
  return {
    projectBudget: { limit: featureConfig.monthlyBudget, spent, remaining },
    taskPolicy: {
      maxPerRequest: featureConfig.maxPerRequest,
      allowedModels: featureConfig.allowedModels,
      fallbackModel: featureConfig.fallbackModel,
      onLimit: featureConfig.onLimit,
    },
  };
}

export interface EstimateSpendParams {
  project: string;
  feature: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  numCalls: number;
}

export function estimateSpend(runtime: SpendSpecRuntime, params: EstimateSpendParams): number {
  runtime.getFeatureConfig(params.project, params.feature);
  const perCall = computeCost(params.model, params.estimatedInputTokens, params.estimatedOutputTokens);
  return perCall * params.numCalls;
}

export interface RequestMoreBudgetResult {
  approved: boolean;
  status: 'approved' | 'pending_approval';
}

const AUTO_APPROVE_CEILING = 1.0;

export function requestMoreBudget(
  runtime: SpendSpecRuntime,
  project: string,
  feature: string,
  amount: number,
  reason: string
): RequestMoreBudgetResult {
  if (amount <= AUTO_APPROVE_CEILING) {
    runtime.leaseManager.grantAdditionalBudget(project, feature, amount);
    console.log(`[approval] auto-approved $${amount.toFixed(2)} for ${project}/${feature}: ${reason}`);
    return { approved: true, status: 'approved' };
  }
  console.log(`[approval] PENDING $${amount.toFixed(2)} for ${project}/${feature}: ${reason}`);
  return { approved: false, status: 'pending_approval' };
}

export interface RecordUsageParams {
  leaseId: string;
  team: string;
  task: string;
  actualCost: number;
  model: string;
  costCenter: string;
}

export function recordUsage(runtime: SpendSpecRuntime, params: RecordUsageParams): void {
  const lease = runtime.leaseManager.getLease(params.leaseId);
  runtime.leaseManager.recordSpend(params.leaseId, params.actualCost);
  runtime.store.addReceipt({
    team: params.team,
    project: lease.project,
    feature: lease.feature,
    task: params.task,
    authorized: lease.reservedAmount,
    actual: params.actualCost,
    model: params.model,
    costCenter: params.costCenter,
    timestamp: new Date().toISOString(),
  });
  runtime.leaseManager.release(params.leaseId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handlers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement `src/mcp-server.ts`** (no test — thin registration wrapper around the tested handlers; verified manually in Step 7)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { SpendSpecRuntime } from './runtime.js';
import { estimateSpend, getSpendPolicy, recordUsage, requestMoreBudget } from './handlers.js';

export function createMcpServer(runtime: SpendSpecRuntime): McpServer {
  const server = new McpServer({ name: 'spendspec', version: '0.1.0' });

  server.tool(
    'get_spend_policy',
    'Get remaining budget and spend policy for a project/feature before starting a task.',
    { project: z.string(), feature: z.string() },
    async ({ project, feature }) => ({
      content: [{ type: 'text', text: JSON.stringify(getSpendPolicy(runtime, project, feature)) }],
    })
  );

  server.tool(
    'estimate_spend',
    'Estimate the dollar cost of a planned task given token counts and number of calls.',
    {
      project: z.string(),
      feature: z.string(),
      model: z.string(),
      estimatedInputTokens: z.number(),
      estimatedOutputTokens: z.number(),
      numCalls: z.number(),
    },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify({ estimatedCost: estimateSpend(runtime, params) }) }],
    })
  );

  server.tool(
    'request_more_budget',
    'Request additional budget for a project/feature above its current limit.',
    { project: z.string(), feature: z.string(), amount: z.number(), reason: z.string() },
    async ({ project, feature, amount, reason }) => ({
      content: [{ type: 'text', text: JSON.stringify(requestMoreBudget(runtime, project, feature, amount, reason)) }],
    })
  );

  server.tool(
    'record_usage',
    'Record actual usage against a budget lease and emit a spend receipt.',
    {
      leaseId: z.string(),
      team: z.string(),
      task: z.string(),
      actualCost: z.number(),
      model: z.string(),
      costCenter: z.string(),
    },
    async (params) => {
      recordUsage(runtime, params);
      return { content: [{ type: 'text', text: JSON.stringify({ recorded: true }) }] };
    }
  );

  return server;
}

export async function startMcpServer(runtime: SpendSpecRuntime): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 6: Implement `bin/mcp-server.ts`**

```ts
import { SpendSpecRuntime } from '../src/runtime.js';
import { startMcpServer } from '../src/mcp-server.js';

const runtime = new SpendSpecRuntime(
  process.env.SPENDSPEC_CONFIG ?? 'spendspec.yaml',
  process.env.SPENDSPEC_STORE ?? '.spendspec/store.json'
);
startMcpServer(runtime);
```

- [ ] **Step 7: Smoke-test the MCP server starts without error**

Run: `timeout 2 npx tsx bin/mcp-server.ts; echo "exit code: $?"`
Expected: process starts and blocks on stdio (no thrown error before the timeout kills it); exit code 124 (timeout) is the expected/healthy outcome here, not a failure.

- [ ] **Step 8: Commit**

```bash
git add src/handlers.ts src/mcp-server.ts bin/mcp-server.ts tests/handlers.test.ts
git commit -m "Add MCP server exposing the 4 SpendSpec tools"
```

---

### Task 9: LLM proxy (SpendSpecClient)

**Files:**
- Create: `src/proxy.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: `SpendSpecRuntime` (Task 7), `computeCost` (Task 4), `SpendLimitExceededError` (Task 6), `requestMoreBudget` (Task 8).
- Produces: `RunOptions`, `RunResult` types and `SpendSpecClient` class with `run(options: RunOptions): Promise<RunResult>` — used by the demo harness (Task 10).

- [ ] **Step 1: Write the failing test**

Create `tests/proxy.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendSpecRuntime } from '../src/runtime.js';
import { SpendSpecClient } from '../src/proxy.js';
import { SpendLimitExceededError } from '../src/lease.js';

let tmpDir: string;
let runtime: SpendSpecRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-proxy-'));
  runtime = new SpendSpecRuntime('spendspec.yaml', path.join(tmpDir, 'store.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeAnthropic(usage: { input_tokens: number; output_tokens: number }) {
  return {
    messages: {
      create: async () => ({
        id: 'msg_test',
        usage,
        content: [{ type: 'text', text: 'ok' }],
      }),
    },
  } as any;
}

const baseOptions = {
  project: 'research-agent',
  feature: 'default',
  task: 'test task',
  team: 'hackathon-demo',
  costCenter: 'Product COGS',
  estimatedInputTokens: 500,
  estimatedOutputTokens: 300,
  maxTokens: 300,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('SpendSpecClient.run', () => {
  it('runs within budget, records a receipt, and releases the lease', async () => {
    const client = new SpendSpecClient(runtime, fakeAnthropic({ input_tokens: 500, output_tokens: 300 }));
    const result = await client.run(baseOptions);

    expect(result.degraded).toBe(false);
    expect(result.actualCost).toBeGreaterThan(0);
    expect(runtime.store.getSpend('research-agent', 'default')).toBeCloseTo(result.actualCost);
  });

  it('degrades to the fallback model when actual usage exceeds the lease', async () => {
    // Force a huge output-token count so actual cost blows past any reserved lease.
    const client = new SpendSpecClient(
      runtime,
      fakeAnthropic({ input_tokens: 500, output_tokens: 2_000_000 })
    );
    const result = await client.run(baseOptions);

    expect(result.degraded).toBe(true);
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('throws SpendLimitExceededError when reserving more than remaining budget', async () => {
    const client = new SpendSpecClient(runtime, fakeAnthropic({ input_tokens: 500, output_tokens: 300 }));
    await expect(
      client.run({ ...baseOptions, estimatedInputTokens: 10_000_000, estimatedOutputTokens: 10_000_000 })
    ).rejects.toThrow(SpendLimitExceededError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proxy.test.ts`
Expected: FAIL — `Cannot find module '../src/proxy.js'`.

- [ ] **Step 3: Implement `src/proxy.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { SpendSpecRuntime } from './runtime.js';
import { computeCost } from './pricing.js';
import { SpendLimitExceededError } from './lease.js';
import { requestMoreBudget } from './handlers.js';

export interface RunOptions {
  project: string;
  feature: string;
  task: string;
  team: string;
  costCenter: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  maxTokens: number;
  messages: Anthropic.MessageParam[];
}

export interface RunResult {
  model: string;
  actualCost: number;
  degraded: boolean;
  message: Anthropic.Message;
}

type AnthropicLike = Pick<Anthropic, 'messages'>;

export class SpendSpecClient {
  constructor(private runtime: SpendSpecRuntime, private anthropic: AnthropicLike) {}

  async run(options: RunOptions): Promise<RunResult> {
    const { featureConfig } = this.runtime.getFeatureConfig(options.project, options.feature);
    const mostExpensive = [...featureConfig.allowedModels].sort(
      (a, b) => computeCost(b, 1, 1) - computeCost(a, 1, 1)
    )[0];
    const estimate = computeCost(mostExpensive, options.estimatedInputTokens, options.estimatedOutputTokens);
    const remaining = this.runtime.leaseManager.getRemainingBudget(options.project, options.feature);

    let model = this.runtime.router.route({
      remainingBudget: remaining,
      taskEstimate: estimate,
      allowedModels: featureConfig.allowedModels,
      fallbackModel: featureConfig.fallbackModel,
    });

    const reservedAmount = Math.min(
      featureConfig.maxPerRequest,
      computeCost(model, options.estimatedInputTokens, options.estimatedOutputTokens) * 1.2
    );

    const lease = this.runtime.leaseManager.reserve(options.project, options.feature, reservedAmount);

    let degraded = false;
    let message = await this.callModel(model, options);
    let actualCost = computeCost(model, message.usage.input_tokens, message.usage.output_tokens);

    if (actualCost > lease.reservedAmount) {
      if (featureConfig.onLimit === 'degrade' && model !== featureConfig.fallbackModel) {
        model = featureConfig.fallbackModel;
        degraded = true;
        message = await this.callModel(model, options);
        actualCost = computeCost(model, message.usage.input_tokens, message.usage.output_tokens);
      } else if (featureConfig.onLimit === 'request-approval') {
        const shortfall = actualCost - lease.reservedAmount;
        const result = requestMoreBudget(
          this.runtime,
          options.project,
          options.feature,
          shortfall,
          `Overrun on task "${options.task}"`
        );
        if (!result.approved) {
          throw new SpendLimitExceededError(
            `Task "${options.task}" exceeded its $${lease.reservedAmount.toFixed(4)} lease and approval is pending`
          );
        }
      } else {
        throw new SpendLimitExceededError(
          `Task "${options.task}" exceeded its $${lease.reservedAmount.toFixed(4)} lease`
        );
      }
    }

    this.runtime.leaseManager.recordSpend(lease.leaseId, actualCost);
    this.runtime.store.addReceipt({
      team: options.team,
      project: options.project,
      feature: options.feature,
      task: options.task,
      authorized: lease.reservedAmount,
      actual: actualCost,
      model,
      costCenter: options.costCenter,
      timestamp: new Date().toISOString(),
    });
    this.runtime.leaseManager.release(lease.leaseId);

    return { model, actualCost, degraded, message };
  }

  private async callModel(model: string, options: RunOptions): Promise<Anthropic.Message> {
    return this.anthropic.messages.create({
      model,
      max_tokens: options.maxTokens,
      messages: options.messages,
    }) as Promise<Anthropic.Message>;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proxy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests across every task pass (config, store, pricing, router, lease, runtime, handlers, proxy).

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts tests/proxy.test.ts
git commit -m "Add real-Anthropic LLM proxy with lease enforcement"
```

---

### Task 10: Demo harness

**Files:**
- Create: `demo/run-demo.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `SpendSpecRuntime` (Task 7), `SpendSpecClient` (Task 9).
- Produces: a runnable CLI script; no further tasks depend on it.

- [ ] **Step 1: Implement `demo/run-demo.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { SpendSpecRuntime } from '../src/runtime.js';
import { SpendSpecClient } from '../src/proxy.js';

async function main() {
  const runtime = new SpendSpecRuntime('spendspec.yaml', '.spendspec/store.json');
  const anthropic = new Anthropic();
  const client = new SpendSpecClient(runtime, anthropic);

  const project = 'research-agent';
  const feature = 'default';

  const remainingBefore = runtime.leaseManager.getRemainingBudget(project, feature);
  console.log(`Remaining monthly budget: $${remainingBefore.toFixed(2)}`);

  const plannedAgents = 5;
  const perAgentEstimate = 0.5; // dollars, rough per-agent estimate at premium model rates
  const plannedCost = plannedAgents * perAgentEstimate;
  console.log(`Estimated cost with ${plannedAgents} agents: $${plannedCost.toFixed(2)}`);

  const revisedAgents = plannedCost > remainingBefore ? 2 : plannedAgents;
  console.log(`Revised plan: use ${revisedAgents} agents`);

  const task = 'Research authentication libraries in this repository';
  const results = await Promise.all(
    Array.from({ length: revisedAgents }, (_, i) =>
      client.run({
        project,
        feature,
        task: `${task} (agent ${i + 1})`,
        team: runtime.config.team,
        costCenter: 'Product COGS',
        estimatedInputTokens: 500,
        estimatedOutputTokens: 300,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: `Summarize best practices for authentication libraries, focusing on aspect ${i + 1}.`,
          },
        ],
      })
    )
  );

  const totalActual = results.reduce((sum, r) => sum + r.actualCost, 0);
  console.log(`Authorized: $${remainingBefore.toFixed(2)}`);
  console.log(`Spent: $${totalActual.toFixed(4)}`);
  console.log(`Saved against initial plan: $${(plannedCost - totalActual).toFixed(4)}`);
  results.forEach((r, i) =>
    console.log(`  agent ${i + 1}: model=${r.model} cost=$${r.actualCost.toFixed(4)} degraded=${r.degraded}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Write `README.md`**

```markdown
# SpendSpec

Gives every AI call a team/project/feature identity, a visible budget policy,
and runtime-enforced spending limits before it runs.

## Setup

```bash
npm install
node scripts/port-price-table.mjs   # regenerate src/pricing/model_price.json if needed
export ANTHROPIC_API_KEY=sk-...
```

## Run the tests

```bash
npm test
```

## Run the MCP server

```bash
npm run mcp-server
```

Exposes 4 tools over stdio: `get_spend_policy`, `estimate_spend`,
`request_more_budget`, `record_usage`. Point a Claude Code MCP client
config at `bin/mcp-server.ts` (run via `tsx`) to call these tools live.

## Run the demo

```bash
npm run demo
```

Makes real, billed Anthropic API calls against the `research-agent` project
in `spendspec.yaml` ($2/month demo budget) and prints the before/after cost
comparison plus final receipts.
```

- [ ] **Step 3: Run the demo manually to confirm it works end-to-end**

Run: `ANTHROPIC_API_KEY=<your key> npm run demo`
Expected: console output showing remaining budget, the revised agent-count plan, per-agent model/cost lines, and a final "Saved against initial plan" line. This step is manual verification, not part of `npm test` — it costs real money and depends on a live API key.

- [ ] **Step 4: Commit**

```bash
git add demo/run-demo.ts README.md
git commit -m "Add demo harness reproducing the Best Builder Cup transcript"
```

---

## Plan self-review notes

- **Spec coverage:** config layer (Task 2), mock Ramp store (Task 3), price table + BudgetRouter (Tasks 4–5), MCP server's 4 tools (Task 8), LLM proxy + budget leases (Tasks 6, 9), mock Ramp receipts (wired into Task 3/8/9), demo harness (Task 10) — every component in the design doc has a task.
- **Placeholder scan:** no TBD/TODO markers; every step has runnable code or an exact command.
- **Type consistency:** `Lease`, `SpendConfig`, `FeatureConfig`, `RunOptions`/`RunResult`, and the four handler param/result types are defined once (Tasks 2, 6, 8, 9) and reused with matching names/shapes in every later task and test.
- **Scope check:** single coherent MVP, no sub-project split needed — each task builds on the previous and produces independently testable software.
