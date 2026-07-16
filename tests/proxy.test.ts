import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendSpecRuntime } from '../src/runtime.js';
import { SpendSpecClient } from '../src/proxy.js';
import { SpendLimitExceededError } from '../src/lease.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let runtime: SpendSpecRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spendspec-proxy-'));
  runtime = new SpendSpecRuntime('spendspec.yaml', path.join(tmpDir, 'store.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeAnthropic(usage: { input_tokens: number; output_tokens: number }) {
  return {
    messages: {
      create: async () => ({
        id: 'msg_test',
        usage,
        content: [{ type: 'text', text: 'ok' }],
      }),
    },
  } as any;
}

// Returns `usages[callIndex]` for each successive `create` call, repeating the
// last entry once the sequence is exhausted. Lets tests give the initial call
// and a degrade retry (which targets a different model) different usage.
function fakeAnthropicSequence(usages: Array<{ input_tokens: number; output_tokens: number }>) {
  let callIndex = 0;
  return {
    messages: {
      create: async () => {
        const usage = usages[Math.min(callIndex, usages.length - 1)];
        callIndex += 1;
        return {
          id: 'msg_test',
          usage,
          content: [{ type: 'text', text: 'ok' }],
        };
      },
    },
  } as any;
}

const baseOptions = {
  project: 'research-agent',
  feature: 'default',
  task: 'test task',
  team: 'hackathon-demo',
  costCenter: 'Product COGS',
  estimatedInputTokens: 500,
  estimatedOutputTokens: 300,
  maxTokens: 300,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('SpendSpecClient.run', () => {
  it('runs within budget, records a receipt, and releases the lease', async () => {
    const client = new SpendSpecClient(runtime, fakeAnthropic({ input_tokens: 500, output_tokens: 300 }));
    const result = await client.run(baseOptions);

    expect(result.degraded).toBe(false);
    expect(result.actualCost).toBeGreaterThan(0);
    expect(runtime.store.getSpend('research-agent', 'default')).toBeCloseTo(result.actualCost);
  });

  it('degrades to the fallback model when actual usage exceeds the lease', async () => {
    // Initial call on claude-sonnet-5 blows past the reserved lease; the fallback
    // (haiku) retry comes back cheap enough to fit within the lease, so it succeeds.
    const client = new SpendSpecClient(
      runtime,
      fakeAnthropicSequence([
        { input_tokens: 500, output_tokens: 2_000_000 },
        { input_tokens: 500, output_tokens: 300 },
      ])
    );
    const result = await client.run(baseOptions);

    expect(result.degraded).toBe(true);
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('throws SpendLimitExceededError when reserving more than remaining budget', async () => {
    const client = new SpendSpecClient(runtime, fakeAnthropic({ input_tokens: 500, output_tokens: 300 }));
    await expect(
      client.run({ ...baseOptions, estimatedInputTokens: 10_000_000, estimatedOutputTokens: 10_000_000 })
    ).rejects.toThrow(SpendLimitExceededError);
  });

  it('throws SpendLimitExceededError when the degrade retry still exceeds the lease', async () => {
    // Both the initial call and the fallback-model retry come back with huge usage,
    // so even after degrading to the fallback model the cost still blows the lease.
    const client = new SpendSpecClient(
      runtime,
      fakeAnthropicSequence([
        { input_tokens: 500, output_tokens: 2_000_000 },
        { input_tokens: 500, output_tokens: 2_000_000 },
      ])
    );

    await expect(client.run(baseOptions)).rejects.toThrow(SpendLimitExceededError);
    // No receipt should have been recorded for the overrun.
    expect(runtime.store.getSpend('research-agent', 'default')).toBe(0);
  });
});

describe('SpendSpecClient.run with request-approval policy', () => {
  let approvalRuntime: SpendSpecRuntime;

  beforeEach(() => {
    approvalRuntime = new SpendSpecRuntime(
      path.join(__dirname, 'fixtures', 'spendspec-approval.yaml'),
      path.join(tmpDir, 'approval-store.json')
    );
  });

  const approvalOptions = {
    ...baseOptions,
    project: 'approval-agent',
    feature: 'default',
  };

  it('grants budget and succeeds when the overrun is within the auto-approve ceiling', async () => {
    // claude-sonnet-5 output pricing is $15/1M tokens, so ~33,000 output tokens
    // costs just under $0.50 -- comfortably exceeds the tiny reserved lease but
    // stays well under the $1.00 auto-approve ceiling.
    const client = new SpendSpecClient(
      approvalRuntime,
      fakeAnthropic({ input_tokens: 500, output_tokens: 33_000 })
    );

    const result = await client.run(approvalOptions);

    expect(result.actualCost).toBeGreaterThan(0);
    expect(approvalRuntime.store.getSpend('approval-agent', 'default')).toBeCloseTo(result.actualCost);
    // Remaining budget reflects the auto-approved grant: monthlyBudget - reservedAmount
    // (grant exactly offsets the shortfall between actualCost and the lease).
    expect(approvalRuntime.leaseManager.getRemainingBudget('approval-agent', 'default')).toBeGreaterThan(
      5 - result.actualCost
    );
  });

  it('throws SpendLimitExceededError when the overrun exceeds the auto-approve ceiling', async () => {
    // ~200,000 output tokens on claude-sonnet-5 costs ~$3, well past the $1.00
    // auto-approve ceiling, so the request stays pending and the call rejects.
    const client = new SpendSpecClient(
      approvalRuntime,
      fakeAnthropic({ input_tokens: 500, output_tokens: 200_000 })
    );

    await expect(client.run(approvalOptions)).rejects.toThrow(SpendLimitExceededError);
    expect(approvalRuntime.store.getSpend('approval-agent', 'default')).toBe(0);
  });
});
