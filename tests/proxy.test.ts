import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequiredError, SpendLimitExceededError } from '../src/lease.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

function fakeProvider(usage = { input_tokens: 500, output_tokens: 300 }) {
  return {
    createMessage: vi.fn(async () => ({ content: 'ok', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })),
    renderVerdict: vi.fn(async () => {
      throw new Error('not used in this test');
    }),
  };
}

/** A single fake provider that answers both worker calls and controller
 * verdict calls, so tests can exercise the full request-approval flow with
 * one provider instance. */
function fakeProviderWithController(
  workerUsage: { input_tokens: number; output_tokens: number },
  verdict: { successProbability: number; reasoning: string }
) {
  return {
    createMessage: vi.fn(async () => ({
      content: 'ok',
      inputTokens: workerUsage.input_tokens,
      outputTokens: workerUsage.output_tokens,
    })),
    renderVerdict: vi.fn(async () => verdict),
  };
}

/** Wraps a single fake provider as both the anthropic and openai slot, for
 * tests that don't care which provider is dispatched to. */
function anthropicOnly(provider: ReturnType<typeof fakeProvider> | ReturnType<typeof fakeProviderWithController>) {
  return { anthropic: provider, openai: provider } as any;
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

const request = {
  estimatedInputTokens: 500,
  maxTokens: 300,
  messages: [{ role: 'user' as const, content: 'Review this code' }],
};

describe('ScripClient', () => {
  it('preauthorizes a provider call, commits actual usage, then settles one task receipt', async () => {
    const root = await issue();
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    const result = await client.run({ ...request, credential: root.credential });

    expect(provider.createMessage).toHaveBeenCalledOnce();
    expect(result.actualCost).toBeGreaterThan(0);
    const receipt = await runtime.authorizations.settleTask(root.authorization.authorizationId);
    expect(receipt.actual).toBeCloseTo(result.actualCost);
    expect(receipt.requestCount).toBe(1);
    expect(receipt.modelUsage[0].inputTokens).toBe(500);
  });

  it('blocks an unaffordable call before provider network I/O', async () => {
    const root = await issue(0.001);
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('releases the request reservation when the provider fails', async () => {
    const root = await issue(0.1);
    const provider = {
      createMessage: vi.fn(async () => Promise.reject(new Error('provider unavailable'))),
      renderVerdict: vi.fn(),
    };
    const client = new ScripClient(runtime, anthropicOnly(provider));
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
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    await expect(
      client.run({ ...request, credential: child.credential, model: 'claude-sonnet-5', maxTokens: 1_000 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('degrades to the fallback model and succeeds when onLimit is degrade', async () => {
    // support budget: onLimit degrade, fallback claude-haiku-4-5-20251001.
    // sonnet at 500in/300out costs $0.006 (too much for $0.003); haiku at
    // the same tokens costs $0.002 (fits) -> degrade retry should succeed.
    const root = await issueOnBudget('support', 0.003);
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    const result = await client.run({
      ...request,
      credential: root.credential,
      model: 'claude-sonnet-5',
      maxTokens: 300,
    });

    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(provider.createMessage).toHaveBeenCalledOnce();
    expect(provider.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
    );
  });

  it('throws if the fallback model still does not fit after a degrade retry', async () => {
    const root = await issueOnBudget('support', 0.0001);
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('throws ApprovalRequiredError when the controller denies', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const provider = fakeProviderWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.2, reasoning: 'Insufficient evidence of progress.' }
    );
    const client = new ScripClient(runtime, anthropicOnly(provider));
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);
    // The controller call itself happened; the worker call did not.
    expect(provider.renderVerdict).toHaveBeenCalledOnce();
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('grants exactly the shortfall and retries when the controller approves', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const provider = fakeProviderWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.9, reasoning: 'Task is on track.' }
    );
    const client = new ScripClient(runtime, anthropicOnly(provider));

    const result = await client.run({
      ...request,
      credential: root.credential,
      model: 'claude-sonnet-5',
      maxTokens: 300,
    });

    expect(result.model).toBe('claude-sonnet-5');
    expect(provider.renderVerdict).toHaveBeenCalledOnce();
    expect(provider.createMessage).toHaveBeenCalledOnce();
  });

  it('caches the controller verdict - a second blocked request in the same task does not re-invoke it', async () => {
    const root = await issueOnBudget('escalation', 0.0001);
    const provider = fakeProviderWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.2, reasoning: 'Insufficient evidence of progress.' }
    );
    const client = new ScripClient(runtime, anthropicOnly(provider));

    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(ApprovalRequiredError);

    // Only the first attempt should have invoked the controller.
    expect(provider.renderVerdict).toHaveBeenCalledOnce();
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
    const provider = fakeProviderWithController(
      { input_tokens: 500, output_tokens: 300 },
      { successProbability: 0.9, reasoning: 'n/a' }
    );
    const client = new ScripClient(noControllerRuntime, anthropicOnly(provider));

    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(/controllerModel/);
  });

  it('still throws SpendLimitExceededError unchanged when onLimit is deny', async () => {
    // research budget: onLimit deny (unchanged regression coverage).
    const root = await issue(0.0001);
    const provider = fakeProvider();
    const client = new ScripClient(runtime, anthropicOnly(provider));
    await expect(
      client.run({ ...request, credential: root.credential, model: 'claude-sonnet-5', maxTokens: 300 })
    ).rejects.toThrow(SpendLimitExceededError);
    expect(provider.createMessage).not.toHaveBeenCalled();
  });

  it('dispatches to the OpenAI provider for an OpenAI model, leaving the Anthropic provider untouched', async () => {
    const root = await issueOnBudget('cross_provider_demo', 1);
    const anthropicProvider = fakeProvider();
    const openaiProvider = fakeProvider();
    const client = new ScripClient(runtime, { anthropic: anthropicProvider, openai: openaiProvider });

    const result = await client.run({ ...request, credential: root.credential, model: 'gpt-5.6-luna' });

    expect(result.model).toBe('gpt-5.6-luna');
    expect(openaiProvider.createMessage).toHaveBeenCalledOnce();
    expect(anthropicProvider.createMessage).not.toHaveBeenCalled();
  });
});
