import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  InvalidCredentialError,
  SpendLimitExceededError,
  TaskAuthorizationManager,
} from '../src/lease.js';
import { AgentTrackRecordStore, MockRampGateway } from '../src/store.js';

let tmpDir: string;
let ramp: MockRampGateway;
let manager: TaskAuthorizationManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-lease-'));
  ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  manager = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function authorize(allowance = 2, ttlMs?: number) {
  return manager.authorizeTask({ budget: 'research', taskId: 'task-1', task: 'Review a repository', allowance, ttlMs });
}

describe('TaskAuthorizationManager', () => {
  it('mints an opaque task credential and reserves Ramp budget', async () => {
    const issued = await authorize();
    expect(issued.credential).toMatch(/^scrip_/);
    expect(JSON.stringify(issued.authorization)).not.toContain(issued.credential);
    expect(await manager.getBudgetRemaining('research')).toBe(98);
  });

  it('enforces Ramp policy on task allowance', async () => {
    await expect(authorize(11)).rejects.toThrow(SpendLimitExceededError);
  });

  it('delegates a bounded lease to a child agent', async () => {
    const root = await authorize();
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    expect(child.lease.parentLeaseId).toBe(root.lease.leaseId);
    expect(child.lease.allowance).toBe(0.5);
    expect(() => manager.delegate(root.credential, 'researcher-2', 1.6)).toThrow(SpendLimitExceededError);
  });

  it('prevents concurrent requests from oversubscribing one lease', async () => {
    const root = await authorize(1);
    manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.7);
    expect(() =>
      manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.4)
    ).toThrow(SpendLimitExceededError);
  });

  it('releases a failed request reservation', async () => {
    const root = await authorize(1);
    const request = manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.8);
    manager.cancelRequest(request.reservationId);
    expect(() => manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 1)).not.toThrow();
  });

  it('rejects disallowed models and invalid credentials', async () => {
    const root = await authorize();
    expect(() => manager.reserveRequest(root.credential, 'gpt-not-allowed', 0.1)).toThrow(SpendLimitExceededError);
    expect(() => manager.getLeaseForCredential('not-a-credential')).toThrow(InvalidCredentialError);
  });

  it('rejects an expired credential', async () => {
    const root = await authorize(1, -1);
    expect(() => manager.getAuthorizationForCredential(root.credential)).toThrow(InvalidCredentialError);
  });

  it('sweepExpired finds nothing when no authorization has expired', async () => {
    await authorize();
    expect(manager.sweepExpired()).toEqual({ revokedAuthorizations: [], cancelledReservations: [] });
  });

  it('sweepExpired cancels a reservation stuck pending under an expired task, releasing its budget', async () => {
    const root = await authorize(1, 50);
    const reservation = manager.reserveAction(root.credential, 'purchase', 'vendor_dataset_license', 0.4);

    const result = manager.sweepExpired(new Date(Date.now() + 100));

    expect(result.revokedAuthorizations).toEqual([root.authorization.authorizationId]);
    expect(result.cancelledReservations).toEqual([reservation.reservationId]);
    expect(manager.getAuthorization(root.authorization.authorizationId).status).toBe('revoked');
    expect(manager.getAuthorization(root.authorization.authorizationId).pending).toBe(0);
    expect(manager.getLeaseTree(root.authorization.authorizationId)[0].status).toBe('revoked');
  });

  it('sweepExpired never touches an authorization that is not yet expired', async () => {
    const root = await authorize(1);
    manager.reserveAction(root.credential, 'purchase', 'vendor_dataset_license', 0.4);

    const result = manager.sweepExpired();

    expect(result).toEqual({ revokedAuthorizations: [], cancelledReservations: [] });
    expect(manager.getAuthorization(root.authorization.authorizationId).status).toBe('active');
  });

  it('settles one receipt for root and child usage and reports it to Ramp', async () => {
    const root = await authorize(2);
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    const rootRequest = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(rootRequest.reservationId, 100, 50, 0.2);
    const childRequest = manager.reserveRequest(child.credential, 'claude-haiku-4-5-20251001', 0.3);
    manager.commitRequest(childRequest.reservationId, 80, 40, 0.1);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.3);
    expect(receipt.returned).toBeCloseTo(1.7);
    expect(receipt.childAgents).toBe(1);
    expect(receipt.requestCount).toBe(2);
    expect(receipt.modelUsage).toHaveLength(2);
    expect(await ramp.getReportedSpend('ramp-budget-research')).toBeCloseTo(0.3);
    expect(await manager.getBudgetRemaining('research')).toBeCloseTo(99.7);
    expect(() => manager.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });

  it('defaults settlement outcome to unknown when the caller reports none', async () => {
    const root = await authorize(1);
    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.outcome).toBe('unknown');
    expect(receipt.outcomeEvidence).toBeUndefined();
  });

  it('records a reported outcome and evidence on the receipt', async () => {
    const root = await authorize(1);
    const receipt = await manager.settleTask(root.authorization.authorizationId, {
      status: 'success',
      evidence: 'Tests pass and PR was merged',
    });
    expect(receipt.outcome).toBe('success');
    expect(receipt.outcomeEvidence).toBe('Tests pass and PR was merged');
  });

  it('tracks delegation depth and rejects delegating past the configured ceiling', async () => {
    // research budget's max_delegation_depth is 3 in scrip.yaml
    const root = await authorize(1); // depth 0
    const child = manager.delegate(root.credential, 'child', 0.5); // depth 1
    expect(child.lease.depth).toBe(1);
    const grandchild = manager.delegate(child.credential, 'grandchild', 0.1); // depth 2
    expect(grandchild.lease.depth).toBe(2);
    const greatGrandchild = manager.delegate(grandchild.credential, 'great-grandchild', 0.01); // depth 3
    expect(greatGrandchild.lease.depth).toBe(3);

    expect(() => manager.delegate(greatGrandchild.credential, 'too-deep', 0.001)).toThrow(
      SpendLimitExceededError
    );
  });

  it('rejects delegating an allowance below the minimum viable request cost', async () => {
    // research budget's cheapest allowed model is haiku; min_request_input_tokens=500,
    // min_request_output_tokens=200 costs ~$0.0015 at haiku's rate.
    const root = await authorize(1);
    expect(() => manager.delegate(root.credential, 'too-small', 0.0001)).toThrow(
      SpendLimitExceededError
    );
    expect(() => manager.delegate(root.credential, 'just-enough', 0.002)).not.toThrow();
  });

  it('builds an evidence snapshot reflecting usage so far, without closing the task', async () => {
    const root = await authorize(2);
    manager.delegate(root.credential, 'researcher-1', 0.5);
    const request = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(request.reservationId, 100, 50, 0.2);

    const snapshot = manager.getEvidenceSnapshot(root.authorization.authorizationId, 0.05);

    expect(snapshot.task).toBe('Review a repository');
    expect(snapshot.allowance).toBe(2);
    expect(snapshot.spent).toBeCloseTo(0.2);
    expect(snapshot.requestCount).toBe(1);
    expect(snapshot.childAgents).toBe(1);
    expect(snapshot.modelUsage).toHaveLength(1);
    expect(snapshot.requestedShortfall).toBe(0.05);
    expect(snapshot.elapsedSeconds).toBeGreaterThanOrEqual(0);

    // Building the snapshot doesn't settle or otherwise close the task.
    expect(() => manager.getLeaseForCredential(root.credential)).not.toThrow();
  });

  it('grants additional allowance to both the lease and the task authorization', async () => {
    const root = await authorize(1);
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);

    manager.grantAdditionalAllowance(child.credential, 0.3);

    // The child lease can now reserve beyond its original $0.5 allowance.
    expect(() => manager.reserveRequest(child.credential, 'claude-haiku-4-5-20251001', 0.7)).not.toThrow();
  });

  it('reserves and commits a non-inference action with no model concept at all', async () => {
    const root = await authorize(1);
    const reservation = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.02);
    expect(reservation.actionType).toBe('paid_api');
    expect(reservation.label).toBe('exa_search');

    manager.commitAction(reservation.reservationId, 0.018);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.018);
    expect(receipt.actionUsage).toEqual([{ actionType: 'paid_api', count: 1, cost: 0.018 }]);
    // A non-inference action never shows up in the token-level modelUsage breakdown.
    expect(receipt.modelUsage).toHaveLength(0);
  });

  it('enforces the same atomic reservation limits for any action type', async () => {
    const root = await authorize(1);
    manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.7);
    expect(() => manager.reserveAction(root.credential, 'purchase', 'vendor_x', 0.4)).toThrow(
      SpendLimitExceededError
    );
  });

  it('releases a cancelled action reservation back to the lease', async () => {
    const root = await authorize(1);
    const reservation = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.8);
    manager.cancelAction(reservation.reservationId);
    expect(() => manager.reserveAction(root.credential, 'paid_api', 'exa_search', 1)).not.toThrow();
  });

  it('breaks a receipt down by action type across mixed inference and non-inference actions', async () => {
    const root = await authorize(2);
    const inferenceRequest = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(inferenceRequest.reservationId, 100, 50, 0.2);
    const apiAction = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.05);
    manager.commitAction(apiAction.reservationId, 0.02);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.22);
    const byType = Object.fromEntries(receipt.actionUsage.map((u) => [u.actionType, u]));
    expect(byType.inference.count).toBe(1);
    expect(byType.inference.cost).toBeCloseTo(0.2);
    expect(byType.paid_api.count).toBe(1);
    expect(byType.paid_api.cost).toBeCloseTo(0.02);
    expect(receipt.modelUsage).toHaveLength(1);
    expect(receipt.modelUsage[0].model).toBe('claude-sonnet-5');
  });

  it('computes the receipt cost breakdown, workerCount, and actionCount alongside the legacy fields', async () => {
    const root = await authorize(2);
    manager.delegate(root.credential, 'child-1', 0.5);
    const inferenceRequest = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(inferenceRequest.reservationId, 100, 50, 0.2);
    const apiAction = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.05);
    manager.commitAction(apiAction.reservationId, 0.02);

    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.workerCount).toBe(receipt.childAgents);
    expect(receipt.workerCount).toBe(1);
    expect(receipt.actionCount).toBe(receipt.requestCount);
    expect(receipt.actionCount).toBe(2);
    expect(receipt.costs).toEqual({
      inferenceUsd: 0.2,
      paidApiUsd: 0.02,
      cloudComputeUsd: 0,
      purchasesUsd: 0,
      approvalOverheadUsd: 0,
      otherUsd: 0,
    });
  });

  it('tracks an EconomicAction reservation through reserved -> committed and reserved -> cancelled', async () => {
    const root = await authorize(1);
    const committed = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.1, { vendor: 'exa' });
    expect(committed.status).toBe('reserved');
    expect(committed.actionId).toBe(committed.reservationId);
    expect(committed.estimatedCostUsd).toBe(0.1);
    expect(committed.metadata).toEqual({ vendor: 'exa' });
    manager.commitAction(committed.reservationId, 0.07);
    expect(committed.status).toBe('committed');

    const cancelled = manager.reserveAction(root.credential, 'paid_api', 'exa_search', 0.1);
    expect(cancelled.metadata).toEqual({});
    manager.cancelAction(cancelled.reservationId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('returns every lease under a task, root first, in delegation order', async () => {
    const root = await authorize(1);
    const child1 = manager.delegate(root.credential, 'child-1', 0.3);
    const grandchild = manager.delegate(child1.credential, 'grandchild-1', 0.1);
    manager.delegate(root.credential, 'child-2', 0.3);

    const tree = manager.getLeaseTree(root.authorization.authorizationId);
    expect(tree).toHaveLength(4);
    expect(tree[0].agentId).toBe('root');
    expect(tree[0].depth).toBe(0);
    expect(tree.map((l) => l.leaseId)).toContain(child1.lease.leaseId);
    expect(tree.map((l) => l.leaseId)).toContain(grandchild.lease.leaseId);
    expect(tree.every((l) => !('credentialHash' in l))).toBe(true);
  });

  it('returns an empty tree for an unknown authorizationId rather than throwing', () => {
    expect(manager.getLeaseTree('not-a-real-id')).toEqual([]);
  });

  it('persists authorizations and leases across separate manager instances pointed at the same store file', async () => {
    const storePath = path.join(tmpDir, 'leases.json');
    const managerA = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, storePath);
    const issued = await managerA.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 2,
    });

    // A fresh instance, simulating a new CLI process, pointed at the same file.
    const managerB = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, storePath);
    const authorization = managerB.getAuthorization(issued.authorization.authorizationId);
    expect(authorization.allowance).toBe(2);
    expect(authorization.status).toBe('active');

    const receipt = await managerB.settleTask(issued.authorization.authorizationId, { status: 'success' });
    expect(receipt.authorized).toBe(2);
    expect(receipt.actual).toBe(0);

    // A third instance sees the settlement too.
    const managerC = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, storePath);
    expect(managerC.getAuthorization(issued.authorization.authorizationId).status).toBe('settled');
  });

  it('does not persist anything when no storePath is given, matching prior in-memory-only behavior', async () => {
    const noStoreManager = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp);
    const issued = await noStoreManager.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 2,
    });
    expect(fs.readdirSync(tmpDir)).toEqual(['ramp.json']);
    expect(issued.authorization.status).toBe('active');
  });
});

describe('settleLease and adaptive delegation cap', () => {
  it('settles a non-root lease independently of the root task', async () => {
    const root = await authorize(5);
    const child = manager.delegate(root.credential, 'agent-a', 1);
    manager.settleLease(child.lease.leaseId, 'success');

    const lease = manager.getLeaseForCredential(root.credential);
    // root lease itself is untouched by settling a child
    expect(lease.status).toBe('active');
  });

  it('rejects settling a root lease via settleLease', async () => {
    const root = await authorize(5);
    expect(() => manager.settleLease(root.lease.leaseId, 'success')).toThrow(/root lease/);
  });

  it('rejects settling an already-settled lease', async () => {
    const root = await authorize(5);
    const child = manager.delegate(root.credential, 'agent-a', 1);
    manager.settleLease(child.lease.leaseId, 'success');
    expect(() => manager.settleLease(child.lease.leaseId, 'success')).toThrow(/already settled/);
  });

  it('rejects settling a lease with a reservation in flight', async () => {
    const root = await authorize(5);
    const child = manager.delegate(root.credential, 'agent-a', 1);
    manager.reserveRequest(child.credential, 'claude-haiku-4-5-20251001', 0.5);
    expect(() => manager.settleLease(child.lease.leaseId, 'success')).toThrow(/in flight/);
  });

  it('records settlements to the track record store and computes resolve rate', async () => {
    const storePath = path.join(tmpDir, 'track-record.json');
    const trackRecord = new AgentTrackRecordStore(storePath);
    const withTrackRecord = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, undefined, trackRecord);

    const root = await withTrackRecord.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 5,
    });
    const c1 = withTrackRecord.delegate(root.credential, 'agent-a', 1);
    const c2 = withTrackRecord.delegate(root.credential, 'agent-a', 1);
    withTrackRecord.settleLease(c1.lease.leaseId, 'success');
    withTrackRecord.settleLease(c2.lease.leaseId, 'failure');

    const rate = trackRecord.getResolveRate('agent-a');
    expect(rate).toEqual({ agentId: 'agent-a', resolved: 1, total: 2, rate: 0.5 });
  });

  it('gives a full-trust resolve rate to an agentId with no settlement history', () => {
    const trackRecord = new AgentTrackRecordStore(path.join(tmpDir, 'track-record.json'));
    expect(trackRecord.getResolveRate('never-seen')).toEqual({
      agentId: 'never-seen',
      resolved: 0,
      total: 0,
      rate: 1,
    });
  });

  it('does not clamp delegate() for an agentId below minSettlementsForTrust', async () => {
    const storePath = path.join(tmpDir, 'track-record.json');
    const trackRecord = new AgentTrackRecordStore(storePath);
    const withTrackRecord = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, undefined, trackRecord);
    const root = await withTrackRecord.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 5,
    });

    // Two failures - below research's min_settlements_for_trust: 3, so no clamp yet.
    const f1 = withTrackRecord.delegate(root.credential, 'flaky-agent', 1);
    withTrackRecord.settleLease(f1.lease.leaseId, 'failure');
    const f2 = withTrackRecord.delegate(root.credential, 'flaky-agent', 1);
    withTrackRecord.settleLease(f2.lease.leaseId, 'failure');

    const next = withTrackRecord.delegate(root.credential, 'flaky-agent', 1);
    expect(next.lease.allowance).toBe(1);
  });

  it('clamps delegate() below the resolve-rate threshold once minSettlementsForTrust is met', async () => {
    const storePath = path.join(tmpDir, 'track-record.json');
    const trackRecord = new AgentTrackRecordStore(storePath);
    const withTrackRecord = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, undefined, trackRecord);
    const root = await withTrackRecord.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 5,
    });

    // 1 success, 2 failures = 1/3 resolve rate, below research's 0.5 threshold,
    // and total (3) meets min_settlements_for_trust.
    const s1 = withTrackRecord.delegate(root.credential, 'flaky-agent', 0.6);
    withTrackRecord.settleLease(s1.lease.leaseId, 'success');
    const f1 = withTrackRecord.delegate(root.credential, 'flaky-agent', 0.6);
    withTrackRecord.settleLease(f1.lease.leaseId, 'failure');
    const f2 = withTrackRecord.delegate(root.credential, 'flaky-agent', 0.6);
    withTrackRecord.settleLease(f2.lease.leaseId, 'failure');

    const requested = 1;
    const next = withTrackRecord.delegate(root.credential, 'flaky-agent', requested);
    const rate = trackRecord.getResolveRate('flaky-agent');
    expect(next.lease.allowance).toBeCloseTo(requested * rate.rate, 6);
    expect(next.lease.allowance).toBeLessThan(requested);
  });

  it('does not clamp a healthy agentId at or above the resolve-rate threshold', async () => {
    const storePath = path.join(tmpDir, 'track-record.json');
    const trackRecord = new AgentTrackRecordStore(storePath);
    const withTrackRecord = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, undefined, trackRecord);
    const root = await withTrackRecord.authorizeTask({
      budget: 'research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance: 5,
    });

    // 2 successes, 1 failure = 2/3 resolve rate, above the 0.5 threshold.
    for (const outcome of ['success', 'success', 'failure'] as const) {
      const issued = withTrackRecord.delegate(root.credential, 'reliable-agent', 0.5);
      withTrackRecord.settleLease(issued.lease.leaseId, outcome);
    }

    const next = withTrackRecord.delegate(root.credential, 'reliable-agent', 1);
    expect(next.lease.allowance).toBe(1);
  });

  it('leaves delegate() unaffected for budgets that do not configure the adaptive cap', async () => {
    const storePath = path.join(tmpDir, 'track-record.json');
    const trackRecord = new AgentTrackRecordStore(storePath);
    const withTrackRecord = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, undefined, trackRecord);
    const root = await withTrackRecord.authorizeTask({
      budget: 'support', // support has no min_settlements_for_trust configured
      taskId: 'task-1',
      task: 'Handle a ticket',
      allowance: 3,
    });

    for (let i = 0; i < 3; i++) {
      const issued = withTrackRecord.delegate(root.credential, 'flaky-agent', 0.5);
      withTrackRecord.settleLease(issued.lease.leaseId, 'failure');
    }

    const next = withTrackRecord.delegate(root.credential, 'flaky-agent', 1);
    expect(next.lease.allowance).toBe(1);
  });
});

describe('getRunReconstruction', () => {
  it('reconstructs a multi-level delegation tree with per-node cost attribution', async () => {
    const root = await authorize(5);
    // Shape mirrors Ramp's funding-recommendation example: the root
    // coordinates but holds a minority of spend; children do the work.
    const backend = manager.delegate(root.credential, 'backend-fix', 2);
    const frontend = manager.delegate(root.credential, 'frontend-migration', 1.5);
    const audit = manager.delegate(backend.credential, 'caller-audit', 0.5);

    const rootAction = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(rootAction.reservationId, 100, 50, 0.2);
    const backendAction = manager.reserveRequest(backend.credential, 'claude-sonnet-5', 1);
    manager.commitRequest(backendAction.reservationId, 400, 200, 0.9);
    const frontendAction = manager.reserveAction(frontend.credential, 'paid_api', 'exa_search', 0.5);
    manager.commitAction(frontendAction.reservationId, 0.4);
    const auditAction = manager.reserveRequest(audit.credential, 'claude-sonnet-5', 0.3);
    manager.commitRequest(auditAction.reservationId, 50, 25, 0.25);

    const run = manager.getRunReconstruction(root.authorization.authorizationId);

    expect(run.nodeCount).toBe(4);
    expect(run.maxDepth).toBe(2);
    expect(run.totalSpent).toBeCloseTo(1.75);
    expect(run.attributedCost).toBeCloseTo(1.75);
    expect(run.unattributedCost).toBe(0);

    // The root's own spend is a minority of the run it coordinated.
    expect(run.root.spent).toBeCloseTo(0.2);
    expect(run.root.subtreeSpent).toBeCloseTo(1.75);
    expect(run.root.agentId).toBe(root.lease.agentId);

    const byAgent = Object.fromEntries(run.root.children.map((child) => [child.agentId, child]));
    expect(Object.keys(byAgent).sort()).toEqual(['backend-fix', 'frontend-migration']);

    // Per-node action-type attribution, not a run-wide split.
    expect(byAgent['frontend-migration'].costs.paidApiUsd).toBeCloseTo(0.4);
    expect(byAgent['frontend-migration'].costs.inferenceUsd).toBe(0);
    expect(byAgent['backend-fix'].costs.inferenceUsd).toBeCloseTo(0.9);
    expect(byAgent['backend-fix'].costs.paidApiUsd).toBe(0);
    expect(byAgent['backend-fix'].actionCount).toBe(1);

    // A grandchild rolls into its parent's subtree but not the parent's own spend.
    const grandchild = byAgent['backend-fix'].children[0];
    expect(grandchild.agentId).toBe('caller-audit');
    expect(grandchild.depth).toBe(2);
    expect(byAgent['backend-fix'].spent).toBeCloseTo(0.9);
    expect(byAgent['backend-fix'].subtreeSpent).toBeCloseTo(1.15);
  });

  it('carries each delegated agent\'s own settled outcome onto its node', async () => {
    const root = await authorize(2);
    const good = manager.delegate(root.credential, 'delivered', 0.5);
    const bad = manager.delegate(root.credential, 'gave-up', 0.5);
    manager.settleLease(good.lease.leaseId, 'success');
    manager.settleLease(bad.lease.leaseId, 'failure');

    const run = manager.getRunReconstruction(root.authorization.authorizationId);
    const byAgent = Object.fromEntries(run.root.children.map((child) => [child.agentId, child]));
    expect(byAgent['delivered'].outcome).toBe('success');
    expect(byAgent['gave-up'].outcome).toBe('failure');
  });

  it('reconstructs an undelegated run as a single root node', async () => {
    const root = await authorize(1);
    const request = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(request.reservationId, 100, 50, 0.2);

    const run = manager.getRunReconstruction(root.authorization.authorizationId);
    expect(run.nodeCount).toBe(1);
    expect(run.maxDepth).toBe(0);
    expect(run.root.children).toEqual([]);
    expect(run.root.spent).toBeCloseTo(0.2);
    expect(run.root.subtreeSpent).toBeCloseTo(0.2);
  });

  it('is read-only - leaves an active run settleable afterward', async () => {
    const root = await authorize(1);
    const request = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(request.reservationId, 100, 50, 0.2);

    manager.getRunReconstruction(root.authorization.authorizationId);

    const stillActive = manager.getRunReconstruction(root.authorization.authorizationId);
    expect(stillActive.status).toBe('active');
    expect(stillActive.root.status).toBe('active');
    const receipt = await manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.2);
  });

  it('rejects an unknown authorization', () => {
    expect(() => manager.getRunReconstruction('no-such-authorization')).toThrow(/No such task authorization/);
  });

  it('reports spend from events predating ActionEvent.leaseId as unattributed', async () => {
    // A store written before ActionEvent carried leaseId. lease.spent stays
    // authoritative; only the per-node action breakdown degrades.
    const storePath = path.join(tmpDir, 'legacy-state.json');
    const persisted = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, storePath);
    const root = await persisted.authorizeTask({
      budget: 'research',
      taskId: 'task-legacy',
      task: 'Review a repository',
      allowance: 2,
    });
    const request = persisted.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    persisted.commitRequest(request.reservationId, 100, 50, 0.2);

    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    for (const events of Object.values(raw.usage) as { leaseId?: string }[][]) {
      for (const event of events) delete event.leaseId;
    }
    fs.writeFileSync(storePath, JSON.stringify(raw));

    const reloaded = new TaskAuthorizationManager(loadConfig('scrip.yaml'), ramp, storePath);
    const run = reloaded.getRunReconstruction(root.authorization.authorizationId);
    expect(run.totalSpent).toBeCloseTo(0.2);
    expect(run.unattributedCost).toBeCloseTo(0.2);
    expect(run.attributedCost).toBe(0);
    expect(run.root.spent).toBeCloseTo(0.2);
    expect(run.root.costs.inferenceUsd).toBe(0);
    expect(run.root.actionCount).toBe(0);
  });
});
