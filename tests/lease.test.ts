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
import { MockRampGateway } from '../src/store.js';

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
