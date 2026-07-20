import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequiredError, SpendLimitExceededError } from '../src/lease.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let runtime: ScripRuntime;
let ramp: MockRampGateway;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-proxy-'));
  ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function issue(allowance = 1) {
  return runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: 'task-1',
    task: 'Review code',
    allowance,
  });
}

function issueOnBudget(budget: string, allowance: number) {
  return runtime.authorizations.authorizeTask({
    budget,
    taskId: 'task-1',
    task: 'Review code',
    allowance,
  });
}

function fakeAnthropic(usage = { input_tokens: 500, output_tokens: 300 }) {
  return {
    messages: {
      create: vi.fn(async () => ({ id: 'msg_test', usage, content: [{ type: 'text', text: 'ok' }] })),
    },
  } as any;
}

const request = {
  estimatedInputTokens: 500,
  maxTokens: 300,
  messages: [{ role: 'user' as const, content: 'Review this code' }],
};

describe('ScripClient', () => {
  it('preauthorizes a provider call, commits actual usage, then settles one task receipt', async () => {
    const root = issue();
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    const result = await client.run({ ...request, credential: root.credential });

    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    expect(result.actualCost).toBeGreaterThan(0);
    const receipt = runtime.authorizations.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(result.actualCost);
    expect(receipt.requestCount).toBe(1);
    expect(receipt.modelUsage[0].inputTokens).toBe(500);
  });

  it('blocks an unaffordable call before provider network I/O', async () => {
    const root = issue(0.001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('releases the request reservation when the provider fails', async () => {
    const root = issue(0.1);
    const anthropic = {
      messages: { create: vi.fn(async () => Promise.reject(new Error('provider unavailable'))) },
    } as any;
    const client = new ScripClient(runtime, anthropic);
    await expect(client.run({ ...request, credential: root.credential })).rejects.toThrow('provider unavailable');
    expect(runtime.authorizations.getAuthorization(root.authorization.authorizationId).pending).toBeCloseTo(0);
  });

  it('enforces a child agent allowance independently of the parent task', async () => {
    const root = issue(1);
    // Above the research budget's minimum-viable-allowance floor ($0.0015 at
    // haiku's rate for 500in/200out tokens) but still far short of what a
    // 1,000-max-token sonnet call costs, so the *request-level* reservation
    // is what's expected to reject this, not the delegation-level floor.
    const child = runtime.authorizations.delegate(root.credential, 'child-1', 0.002);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: child.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('degrades to the fallback model and succeeds when onLimit is degrade', async () => {
    // support budget: onLimit degrade, fallback claude-haiku-4-5-20251001.
    // sonnet at 500in/300out costs $0.006 (too much for $0.003); haiku at
    // the same tokens costs $0.002 (fits) -> degrade retry should succeed.
    const root = issueOnBudget('support', 0.003);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    const result = await client.run({
      ...request,
      credential: root.credential,
      model: 'claude-sonnet-5',
      maxTokens: 300,
    });

    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
    );
  });

  it('throws if the fallback model still does not fit after a degrade retry', async () => {
    const root = issueOnBudget('support', 0.0001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('throws ApprovalRequiredError when onLimit is request-approval and the request does not fit', async () => {
    const root = issueOnBudget('escalation', 0.0001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('still throws SpendLimitExceededError unchanged when onLimit is deny', async () => {
    // research budget: onLimit deny (unchanged regression coverage).
    const root = issue(0.0001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});
