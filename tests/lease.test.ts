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

function authorize(allowance = 2, ttlMs?: number) {
  return manager.authorizeTask({ budget: 'research', taskId: 'task-1', task: 'Review a repository', allowance, ttlMs });
}

describe('TaskAuthorizationManager', () => {
  it('mints an opaque task credential and reserves Ramp budget', () => {
    const issued = authorize();
    expect(issued.credential).toMatch(/^scrip_/);
    expect(JSON.stringify(issued.authorization)).not.toContain(issued.credential);
    expect(manager.getBudgetRemaining('research')).toBe(98);
  });

  it('enforces Ramp policy on task allowance', () => {
    expect(() => authorize(11)).toThrow(SpendLimitExceededError);
  });

  it('delegates a bounded lease to a child agent', () => {
    const root = authorize();
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    expect(child.lease.parentLeaseId).toBe(root.lease.leaseId);
    expect(child.lease.allowance).toBe(0.5);
    expect(() => manager.delegate(root.credential, 'researcher-2', 1.6)).toThrow(SpendLimitExceededError);
  });

  it('prevents concurrent requests from oversubscribing one lease', () => {
    const root = authorize(1);
    manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.7);
    expect(() =>
      manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.4)
    ).toThrow(SpendLimitExceededError);
  });

  it('releases a failed request reservation', () => {
    const root = authorize(1);
    const request = manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 0.8);
    manager.cancelRequest(request.reservationId);
    expect(() => manager.reserveRequest(root.credential, 'claude-haiku-4-5-20251001', 1)).not.toThrow();
  });

  it('rejects disallowed models and invalid credentials', () => {
    const root = authorize();
    expect(() => manager.reserveRequest(root.credential, 'gpt-not-allowed', 0.1)).toThrow(SpendLimitExceededError);
    expect(() => manager.getLeaseForCredential('not-a-credential')).toThrow(InvalidCredentialError);
  });

  it('rejects an expired credential', () => {
    const root = authorize(1, -1);
    expect(() => manager.getAuthorizationForCredential(root.credential)).toThrow(InvalidCredentialError);
  });

  it('settles one receipt for root and child usage and reports it to Ramp', () => {
    const root = authorize(2);
    const child = manager.delegate(root.credential, 'researcher-1', 0.5);
    const rootRequest = manager.reserveRequest(root.credential, 'claude-sonnet-5', 0.4);
    manager.commitRequest(rootRequest.reservationId, 100, 50, 0.2);
    const childRequest = manager.reserveRequest(child.credential, 'claude-haiku-4-5-20251001', 0.3);
    manager.commitRequest(childRequest.reservationId, 80, 40, 0.1);

    const receipt = manager.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(0.3);
    expect(receipt.returned).toBeCloseTo(1.7);
    expect(receipt.childAgents).toBe(1);
    expect(receipt.requestCount).toBe(2);
    expect(receipt.modelUsage).toHaveLength(2);
    expect(ramp.getReportedSpend('ramp-budget-research')).toBeCloseTo(0.3);
    expect(manager.getBudgetRemaining('research')).toBeCloseTo(99.7);
    expect(() => manager.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });
});
