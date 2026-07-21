import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockRampGateway, type TaskReceipt } from '../src/store.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-ramp-'));
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
    actionUsage: [],
    costCenter: 'AI compute',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    outcome: 'unknown',
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
