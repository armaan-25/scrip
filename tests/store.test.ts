import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTrackRecordStore, LocalFinanceGateway, type LeaseSettlement, type TaskReceipt } from '../src/store.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-finance-'));
  filePath = path.join(tmpDir, 'ledger.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    receiptId: 'receipt-1',
    authorizationId: 'auth-1',
    entityId: 'entity-1',
    budgetId: 'budget-1',
    team: 'agents',
    taskId: 'task-1',
    task: 'Review code',
    authorized: 2,
    actual: 0.5,
    returned: 1.5,
    childAgents: 1,
    workerCount: 1,
    requestCount: 1,
    actionCount: 1,
    modelUsage: [],
    actionUsage: [],
    costs: { inferenceUsd: 0, paidApiUsd: 0, cloudComputeUsd: 0, purchasesUsd: 0, approvalOverheadUsd: 0, otherUsd: 0 },
    costCenter: 'AI compute',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    outcome: 'unknown',
    ...overrides,
  };
}

describe('LocalFinanceGateway', () => {
  it('persists task receipts and reports spend by budget', async () => {
    const finance = new LocalFinanceGateway(filePath);
    await finance.reportTaskUsage(receipt());
    await finance.reportTaskUsage(receipt({ receiptId: 'receipt-2', actual: 0.25 }));
    await finance.reportTaskUsage(receipt({ receiptId: 'receipt-3', budgetId: 'budget-2', actual: 9 }));
    expect(await finance.getReportedSpend('budget-1')).toBeCloseTo(0.75);
    expect(finance.getReceipts()).toHaveLength(3);
  });

  it('excludes receipts outside the requested month', async () => {
    const finance = new LocalFinanceGateway(filePath);
    await finance.reportTaskUsage(receipt({ settledAt: '2020-01-15T00:00:00.000Z' }));
    expect(await finance.getReportedSpend('budget-1', '2026-07')).toBe(0);
  });

  it('looks up a single receipt by authorizationId', async () => {
    const finance = new LocalFinanceGateway(filePath);
    await finance.reportTaskUsage(receipt({ authorizationId: 'auth-1' }));
    await finance.reportTaskUsage(receipt({ receiptId: 'receipt-2', authorizationId: 'auth-2' }));

    expect((await finance.getReceipt('auth-2'))?.receiptId).toBe('receipt-2');
    expect(await finance.getReceipt('not-a-real-auth')).toBeUndefined();
  });
});

function settlement(overrides: Partial<LeaseSettlement> = {}): LeaseSettlement {
  return {
    agentId: 'agent-a',
    leaseId: 'lease-1',
    authorizationId: 'auth-1',
    outcome: 'success',
    settledAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentTrackRecordStore', () => {
  it('gives a full-trust resolve rate before any settlement is recorded', () => {
    const store = new AgentTrackRecordStore(path.join(tmpDir, 'track-record.json'));
    expect(store.getResolveRate('agent-a')).toEqual({ agentId: 'agent-a', resolved: 0, total: 0, rate: 1 });
  });

  it('counts success and partial as resolved, failure and unknown as not', () => {
    const store = new AgentTrackRecordStore(path.join(tmpDir, 'track-record.json'));
    store.addSettlement(settlement({ leaseId: 'l1', outcome: 'success' }));
    store.addSettlement(settlement({ leaseId: 'l2', outcome: 'partial' }));
    store.addSettlement(settlement({ leaseId: 'l3', outcome: 'failure' }));
    store.addSettlement(settlement({ leaseId: 'l4', outcome: 'unknown' }));

    expect(store.getResolveRate('agent-a')).toEqual({ agentId: 'agent-a', resolved: 2, total: 4, rate: 0.5 });
  });

  it('keeps resolve rates independent per agentId', () => {
    const store = new AgentTrackRecordStore(path.join(tmpDir, 'track-record.json'));
    store.addSettlement(settlement({ agentId: 'agent-a', leaseId: 'l1', outcome: 'success' }));
    store.addSettlement(settlement({ agentId: 'agent-b', leaseId: 'l2', outcome: 'failure' }));

    expect(store.getResolveRate('agent-a').rate).toBe(1);
    expect(store.getResolveRate('agent-b').rate).toBe(0);
  });

  it('persists settlements across separate store instances pointed at the same file', () => {
    const filePath = path.join(tmpDir, 'track-record.json');
    const storeA = new AgentTrackRecordStore(filePath);
    storeA.addSettlement(settlement({ leaseId: 'l1', outcome: 'success' }));

    const storeB = new AgentTrackRecordStore(filePath);
    expect(storeB.getResolveRate('agent-a')).toEqual({ agentId: 'agent-a', resolved: 1, total: 1, rate: 1 });
  });
});
