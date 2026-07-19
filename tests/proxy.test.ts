import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendLimitExceededError } from '../src/lease.js';
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
    const child = runtime.authorizations.delegate(root.credential, 'child-1', 0.001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: child.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});
