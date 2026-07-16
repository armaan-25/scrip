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
