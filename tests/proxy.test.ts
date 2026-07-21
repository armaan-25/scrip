import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequiredError, SpendLimitExceededError } from '../src/lease.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

/** A single fake client that answers both worker calls and controller
 * verdict calls (distinguished by the presence of tool_choice), so tests
 * can exercise the full request-approval flow with one client instance. */
function fakeAnthropicWithController(
  workerUsage: { input_tokens: number; output_tokens: number },
  verdict: { successProbability: number; reasoning: string }
) {
  return {
    messages: {
      create: vi.fn(async (params: any) => {
        if (params.tool_choice) {
          return {
            id: 'msg_verdict',
            content: [{ type: 'tool_use', id: 'tool_1', name: 'render_verdict', input: verdict }],
          };
        }
        return { id: 'msg_test', usage: workerUsage, content: [{ type: 'text', text: 'ok' }] };
      }),
    },
  } as any;
}

let tmpDir: string;
let runtime: ScripRuntime;
let ramp: MockRampGateway;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-proxy-'));
  ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function issue(allowance = 1) {
  return runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: 'task-1',
    task: 'Review code',
    allowance,
  });
}

async function issueOnBudget(budget: string, allowance: number) {
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
    const root = await issue();
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    const result = await client.run({ ...request, credential: root.credential });

    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    expect(result.actualCost).toBeGreaterThan(0);
    const receipt = await runtime.authorizations.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(result.actualCost);
    expect(receipt.requestCount).toBe(1);
    expect(receipt.modelUsage[0].inputTokens).toBe(500);
  });

  it('blocks an unaffordable call before provider network I/O', async () => {
    const root = await issue(0.001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('releases the request reservation when the provider fails', async () => {
    const root = await issue(0.1);
    const anthropic = {
      messages: { create: vi.fn(async () => Promise.reject(new Error('provider unavailable'))) },
    } as any;
    const client = new ScripClient(runtime, anthropic);
    await expect(client.run({ ...request, credential: root.credential })).rejects.toThrow('provider unavailable');
    expect(runtime.authorizations.getAuthorization(root.authorization.authorizationId).pending).toBeCloseTo(0);
  });

  it('enforces a child agent allowance independently of the parent task', async () => {
    const root = await issue(1);
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
    const root = await issueOnBudget('support', 0.003);
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
    const root = await issueOnBudget('support', 0.0001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('throws ApprovalRequiredError when the controller denies', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const anthropic = fakeAnthropicWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.2, reasoning: 'Insufficient evidence of progress.' }
    );
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);
    // The controller call itself happened; the worker call did not.
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
  });

  it('grants exactly the shortfall and retries when the controller approves', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const anthropic = fakeAnthropicWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.9, reasoning: 'Task is on track.' }
    );
    const client = new ScripClient(runtime, anthropic);

    const result = await client.run({
      ...request,
      credential: root.credential,
      model: 'claude-sonnet-5',
      maxTokens: 300,
    });

    expect(result.model).toBe('claude-sonnet-5');
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2); // controller verdict + worker call
  });

  it('caches the controller verdict - a second blocked request in the same task does not re-invoke it', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const anthropic = fakeAnthropicWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.2, reasoning: 'Insufficient evidence of progress.' }
    );
    const client = new ScripClient(runtime, anthropic);

    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);

    // Only the first attempt should have invoked the controller.
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
  });

  it('throws a clear config error when request-approval is set but no controllerModel is configured', async () => {
    // Re-load config without a controller_model by pointing at a temp copy.
    const noControllerYaml = path.join(tmpDir, 'no-controller.yaml');
    const original = fs.readFileSync('scrip.yaml', 'utf-8');
    fs.writeFileSync(noControllerYaml, original.replace(/\n\s*controller_model:.*\n/, '\n'));
    const noControllerRuntime = new ScripRuntime(noControllerYaml, path.join(tmpDir, 'unused2.json'), ramp);

    const root = await noControllerRuntime.authorizations.authorizeTask({
      budget: 'escalation',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 0.0001,
    });
    const anthropic = fakeAnthropicWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.9, reasoning: 'n/a' }
    );
    const client = new ScripClient(noControllerRuntime, anthropic);

    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(/controllerModel/);
  });

  it('still throws SpendLimitExceededError unchanged when onLimit is deny', async () => {
    // research budget: onLimit deny (unchanged regression coverage).
    const root = await issue(0.0001);
    const anthropic = fakeAnthropic();
    const client = new ScripClient(runtime, anthropic);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});
