import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendSpecRuntime } from '../src/runtime.js';
import { SpendSpecClient } from '../src/proxy.js';
import { SpendLimitExceededError } from '../src/lease.js';

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
    // Force a huge output-token count so actual cost blows past any reserved lease.
    const client = new SpendSpecClient(
      runtime,
      fakeAnthropic({ input_tokens: 500, output_tokens: 2_000_000 })
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
});
