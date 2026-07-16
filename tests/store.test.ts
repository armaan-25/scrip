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
