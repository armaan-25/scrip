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
});
