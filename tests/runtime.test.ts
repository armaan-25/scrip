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
