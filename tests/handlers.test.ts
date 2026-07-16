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
