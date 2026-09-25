import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  InvalidCredentialError,
  SpendLimitExceededError,
  TaskAuthorizationManager,
  type LeaseStateStore,
  type PersistedLeaseState,
} from '../src/lease.js';
import type { FinanceGateway, TaskReceipt } from '../src/store.js';

class MemoryFinance implements FinanceGateway {
  receipts: TaskReceipt[] = [];
  async getReportedSpend(budgetId: string): Promise<number> {
    return this.receipts.filter((r) => r.budgetId === budgetId).reduce((sum, r) => sum + r.actual, 0);
  }
  async reportTaskUsage(receipt: TaskReceipt): Promise<void> {
    this.receipts.push(receipt);
  }
}

class MemoryStateStore implements LeaseStateStore {
  state?: string;
  load(): PersistedLeaseState | undefined {
    return this.state ? JSON.parse(this.state) : undefined;
  }
  save(state: PersistedLeaseState): void {
    this.state = JSON.stringify(state);
  }
}

let finance: MemoryFinance;
let manager: TaskAuthorizationManager;

beforeEach(() => {
  finance = new MemoryFinance();
  manager = new TaskAuthorizationManager(loadConfig('scrip.yaml'), finance);
});

async function authorize(allowance = 2, ttlMs?: number) {
  return manager.authorizeTask({ budget: 'research', taskId: 'task-1', task: 'Review a repository', allowance, ttlMs });
}

describe('TaskAuthorizationManager', () => {
  it('mints an opaque task credential and holds the allowance against the monthly budget', async () => {
    const issued = await authorize(2);
    expect(issued.credential).toMatch(/^scrip_/);
    expect(JSON.stringify(issued.authorization)).not.toContain(issued.credential);
    // research: monthly_limit 100, max_task_allowance 10
    for (let i = 0; i < 9; i++) await authorize(10);
    await expect(authorize(10)).rejects.toThrow(/remains/);
  });

  it('enforces budget policy on task allowance', async () => {
    await expect(authorize(11)).rejects.toThrow(SpendLimitExceededError);
  });

  it('delegates a bounded lease to a child agent', async () => {
    const root = await authorize();
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    expect(child.lease.parentLeaseId).toBe(root.lease.leaseId);
    expect(child.lease.allowance).toBe(0.5);
    expect(() => manager.delegate(root.credential, 'researcher-2', 1.6)).toThrow(SpendLimitExceededError);
    expect(() => manager.delegate(root.credential, 'zero', 0)).toThrow(SpendLimitExceededError);
  });

  it('tracks delegation depth and rejects delegating past the configured ceiling', async () => {
    // research budget's max_delegation_depth is 3 in scrip.yaml
    const root = await authorize(1);
    const child = manager.delegate(root.credential, 'child', 0.5);
    const grandchild = manager.delegate(child.credential, 'grandchild', 0.1);
    const greatGrandchild = manager.delegate(grandchild.credential, 'great-grandchild', 0.01);
    expect([child, grandchild, greatGrandchild].map((c) => c.lease.depth)).toEqual([1, 2, 3]);
    expect(() => manager.delegate(greatGrandchild.credential, 'too-deep', 0.001)).toThrow(SpendLimitExceededError);
  });

  it('prevents concurrent reservations from oversubscribing one lease', async () => {
    const root = await authorize(1);
    manager.reserveAction(root.credential, 'paid_api', 'search_api', 0.7);
    expect(() => manager.reserveAction(root.credential, 'purchase', 'vendor_x', 0.4)).toThrow(SpendLimitExceededError);
  });

  it('releases a cancelled reservation back to the lease', async () => {
    const root = await authorize(1);
    const reservation = manager.reserveAction(root.credential, 'paid_api', 'search_api', 0.8);
    manager.cancelAction(reservation.reservationId);
    expect(reservation.status).toBe('cancelled');
    expect(() => manager.reserveAction(root.credential, 'paid_api', 'search_api', 1)).not.toThrow();
  });

  it('cancels and rejects a commit above the reserved maximum', async () => {
    const root = await authorize(1);
    const reservation = manager.reserveAction(root.credential, 'purchase', 'hotel', 0.5);
    expect(() => manager.commitAction(reservation.reservationId, 0.6)).toThrow(SpendLimitExceededError);
    expect(manager.getAuthorization(root.authorization.authorizationId)).toMatchObject({ spent: 0, pending: 0 });
  });

  it('tracks a reservation through reserved -> committed with its metadata', async () => {
    const root = await authorize(1);
    const reservation = manager.reserveAction(root.credential, 'paid_api', 'search_api', 0.1, { vendor: 'search-vendor' });
    expect(reservation).toMatchObject({ status: 'reserved', maximumCost: 0.1, metadata: { vendor: 'search-vendor' } });
    manager.commitAction(reservation.reservationId, 0.07);
    expect(reservation.status).toBe('committed');
    expect(manager.reserveAction(root.credential, 'other', 'x', 0.1).metadata).toEqual({});
  });

  it('rejects invalid and expired credentials', async () => {
    expect(() => manager.reserveAction('not-a-credential', 'purchase', 'x', 0.1)).toThrow(InvalidCredentialError);
    const expired = await authorize(1, -1);
    expect(() => manager.reserveAction(expired.credential, 'purchase', 'x', 0.1)).toThrow(InvalidCredentialError);
  });

  it('settles one receipt for root and child usage and reports it to the finance gateway', async () => {
    const root = await authorize(2);
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    const rootAction = manager.reserveAction(root.credential, 'purchase', 'dataset', 0.4);
    manager.commitAction(rootAction.reservationId, 0.2);
    const childAction = manager.reserveAction(child.credential, 'paid_api', 'search_api', 0.3);
    manager.commitAction(childAction.reservationId, 0.1);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.3);
    expect(receipt.returned).toBeCloseTo(1.7);
    expect(receipt.workerCount).toBe(1);
    expect(receipt.actionCount).toBe(2);
    const byType = Object.fromEntries(receipt.actionUsage.map((u) => [u.actionType, u]));
    expect(byType.purchase).toMatchObject({ count: 1 });
    expect(byType.purchase.cost).toBeCloseTo(0.2);
    expect(byType.paid_api.cost).toBeCloseTo(0.1);
    expect(await finance.getReportedSpend('budget-research')).toBeCloseTo(0.3);
    expect(() => manager.reserveAction(root.credential, 'purchase', 'x', 0.1)).toThrow(InvalidCredentialError);
  });

  it('refuses to settle with a reservation in flight', async () => {
    const root = await authorize(1);
    manager.reserveAction(root.credential, 'purchase', 'hotel', 0.5);
    await expect(manager.settleTask(root.authorization.authorizationId)).rejects.toThrow(/in flight/);
  });

  it('defaults settlement outcome to unknown and records a reported outcome', async () => {
    const first = await authorize(1);
    expect((await manager.settleTask(first.authorization.authorizationId)).outcome).toBe('unknown');

    const second = await authorize(1);
    const receipt = await manager.settleTask(second.authorization.authorizationId, {
      status: 'success',
      evidence: 'Booking confirmed',
    });
    expect(receipt).toMatchObject({ outcome: 'success', outcomeEvidence: 'Booking confirmed' });
  });

  it('returns every lease under a task, root first, without credential hashes', async () => {
    const root = await authorize(1);
    const child1 = manager.delegate(root.credential, 'child-1', 0.3);
    const grandchild = manager.delegate(child1.credential, 'grandchild-1', 0.1);
    manager.delegate(root.credential, 'child-2', 0.3);

    const tree = manager.getLeaseTree(root.authorization.authorizationId);
    expect(tree).toHaveLength(4);
    expect(tree[0]).toMatchObject({ agentId: 'root', depth: 0 });
    expect(tree.map((l) => l.leaseId)).toContain(grandchild.lease.leaseId);
    expect(tree.every((l) => !('credentialHash' in l))).toBe(true);
    expect(manager.getLeaseTree('not-a-real-id')).toEqual([]);
  });

  it('restores authorizations, leases and credentials from a LeaseStateStore', async () => {
    const stateStore = new MemoryStateStore();
    const managerA = new TaskAuthorizationManager(loadConfig('scrip.yaml'), finance, stateStore);
    const issued = await managerA.authorizeTask({ budget: 'research', taskId: 't', task: 'x', allowance: 2 });

    const managerB = new TaskAuthorizationManager(loadConfig('scrip.yaml'), finance, stateStore);
    expect(managerB.getAuthorization(issued.authorization.authorizationId)).toMatchObject({ allowance: 2, status: 'active' });
    const reservation = managerB.reserveAction(issued.credential, 'purchase', 'hotel', 1);
    managerB.commitAction(reservation.reservationId, 1);
    await managerB.settleTask(issued.authorization.authorizationId, { status: 'success' });

    const managerC = new TaskAuthorizationManager(loadConfig('scrip.yaml'), finance, stateStore);
    expect(managerC.getAuthorization(issued.authorization.authorizationId)).toMatchObject({ status: 'settled', spent: 1 });
  });
});
