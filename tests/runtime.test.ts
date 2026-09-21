import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScripRuntime } from '../src/runtime.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-runtime-'));
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ScripRuntime', () => {
  it('wires budget policy, task authorizations, and routing', async () => {
    const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'ledger.json'));
    expect(runtime.config.entityId).toBe('scrip-demo');
    expect(await runtime.authorizations.getBudgetRemaining('research')).toBe(100);
    expect(runtime.getBudget('research').budgetId).toBe('budget-research');
  });

  it('rejects an unknown budget', () => {
    const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'ledger.json'));
    expect(() => runtime.getBudget('unknown')).toThrow('Unknown budget');
  });
});
