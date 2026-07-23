import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeTask,
  cancelAction,
  commitAction,
  delegateTaskAllowance,
  getBudgetPolicy,
  reserveAction,
  revokeTask,
  settleTask,
  showReceipt,
  showTask,
  showTaskTree,
} from '../src/handlers.js';
import { InvalidCredentialError } from '../src/lease.js';
import { ScripRuntime } from '../src/runtime.js';

let tmpDir: string;
let runtime: ScripRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-handlers-'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'ramp.json'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('task credential handlers', () => {
  it('exposes Ramp policy and available task authorization', async () => {
    expect(await getBudgetPolicy(runtime, 'research')).toMatchObject({
      rampBudgetId: 'ramp-budget-research',
      monthlyLimit: 100,
      availableToAuthorize: 100,
      maxTaskAllowance: 10,
    });
  });

  it('reads spend using rampBudgetId, never a resolved Fund ID - regression for a real bug caught via the MCP smoke test', async () => {
    // MockRampGateway's getReportedSpend doesn't care what ID it's given
    // (an empty store returns 0 either way), which is exactly why this bug
    // was invisible to it: handlers.ts once resolved budget.rampFundId
    // before calling getReportedSpend(), double-resolving an ID that
    // RampApiGateway already resolves itself. A spy on the real gateway
    // instance is what actually catches the wrong argument.
    const spy = vi.spyOn(runtime.ramp, 'getReportedSpend');
    await getBudgetPolicy(runtime, 'research');
    expect(spy).toHaveBeenCalledWith('ramp-budget-research');
  });

  it('authorizes, delegates, and settles a task', async () => {
    const root = await authorizeTask(runtime, {
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
    expect(await settleTask(runtime, root.authorization.authorizationId)).toMatchObject({
      authorized: 2,
      actual: 0,
      childAgents: 1,
      outcome: 'unknown',
    });
  });

  it('records a reported outcome when settling', async () => {
    const root = await authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 1,
    });
    const receipt = await settleTask(runtime, root.authorization.authorizationId, {
      status: 'failure',
      evidence: 'Tests still failing after the allowance ran out',
    });
    expect(receipt.outcome).toBe('failure');
    expect(receipt.outcomeEvidence).toBe('Tests still failing after the allowance ran out');
  });

  it('revokes every credential in the task tree', async () => {
    const root = await authorizeTask(runtime, {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 1,
    });
    revokeTask(runtime, root.authorization.authorizationId);
    expect(() => runtime.authorizations.getLeaseForCredential(root.credential)).toThrow(InvalidCredentialError);
  });

  it('shows a task and its lease tree', async () => {
    const root = await authorizeTask(runtime, { budget: 'research', taskId: 'task-1', task: 'Review code', allowance: 1 });
    delegateTaskAllowance(runtime, { parentCredential: root.credential, agentId: 'child-1', allowance: 0.3 });

    expect(showTask(runtime, root.authorization.authorizationId)).toMatchObject({ taskId: 'task-1', status: 'active' });
    const tree = showTaskTree(runtime, root.authorization.authorizationId);
    expect(tree).toHaveLength(2);
    expect(tree[0].agentId).toBe('root');
  });

  it('reserves, commits, and cancels a generic economic action', async () => {
    const root = await authorizeTask(runtime, { budget: 'research', taskId: 'task-1', task: 'Review code', allowance: 1 });

    const reservation = reserveAction(runtime, {
      credential: root.credential,
      actionType: 'paid_api',
      label: 'vendor_comparison_api',
      maximumCost: 0.1,
    });
    expect(reservation.status).toBe('reserved');
    commitAction(runtime, reservation.reservationId, 0.07);
    expect(runtime.authorizations.getAuthorization(root.authorization.authorizationId).spent).toBeCloseTo(0.07);

    const toCancel = reserveAction(runtime, {
      credential: root.credential,
      actionType: 'paid_api',
      label: 'vendor_comparison_api',
      maximumCost: 0.1,
    });
    cancelAction(runtime, toCancel.reservationId);
    expect(runtime.authorizations.getAuthorization(root.authorization.authorizationId).pending).toBeCloseTo(0);
  });

  it('shows a settled receipt, and throws for a task that has not settled', async () => {
    const root = await authorizeTask(runtime, { budget: 'research', taskId: 'task-1', task: 'Review code', allowance: 1 });

    await expect(showReceipt(runtime, root.authorization.authorizationId)).rejects.toThrow(/No settled receipt/);

    await settleTask(runtime, root.authorization.authorizationId, { status: 'success' });
    const receipt = await showReceipt(runtime, root.authorization.authorizationId);
    expect(receipt.authorizationId).toBe(root.authorization.authorizationId);
    expect(receipt.outcome).toBe('success');
  });
});
