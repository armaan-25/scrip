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
  it('wires Ramp policy, task authorizations, and routing', () => {
    const runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
    expect(runtime.config.rampEntityId).toBe('ramp-entity-demo');
    expect(runtime.authorizations.getBudgetRemaining('research')).toBe(100);
    expect(runtime.getBudget('research').rampBudgetId).toBe('ramp-budget-research');
  });

  it('rejects an unknown Ramp budget', () => {
    const runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
    expect(() => runtime.getBudget('unknown')).toThrow('Unknown Ramp budget');
  });
});
