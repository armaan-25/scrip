import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, revokeTask, settleTask } from '../src/handlers.js';
import { InvalidCredentialError } from '../src/lease.js';
import { SpecSpendRuntime } from '../src/runtime.js';

let tmpDir: string;
let runtime: SpecSpendRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specspend-handlers-'));
  runtime = new SpecSpendRuntime('specspend.yaml', path.join(tmpDir, 'ramp.json'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('task credential handlers', () => {
  it('exposes Ramp policy and available task authorization', () => {
    expect(getBudgetPolicy(runtime, 'research')).toMatchObject({
      rampBudgetId: 'ramp-budget-research',
      monthlyLimit: 100,
      availableToAuthorize: 100,
      maxTaskAllowance: 10,
    });
  });

  it('authorizes, delegates, and settles a task', () => {
    const root = authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 2,
    });
    const child = delegateTaskAllowance(runtime, {
      parentCredential: root.credential,
      agentId: 'child-1',
      allowance: 0.5,
    });
    expect(child.lease.authorizationId).toBe(root.authorization.authorizationId);
    expect(settleTask(runtime, root.authorization.authorizationId)).toMatchObject({
      authorized: 2,
      actual: 0,
      childAgents: 1,
    });
  });

  it('revokes every credential in the task tree', () => {
    const root = authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 1,
    });
    revokeTask(runtime, root.authorization.authorizationId);
    expect(() => runtime.authorizations.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });
});
