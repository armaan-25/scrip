import { authorizeTask, settleTask } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, no API key required: proves ScripClient dispatches to a
// different ModelProvider based purely on the routed model's provider tag
// (getModelPrice(model).provider), not on which SDK happens to be wired in.
// Two distinct fake providers, one per key, so a call landing on the wrong
// one would be caught immediately.
function fakeProvider(name: string, inputTokens: number, outputTokens: number) {
  let calls = 0;
  return {
    name,
    get calls() {
      return calls;
    },
    createMessage: async () => {
      calls++;
      return { content: `ok from ${name}`, inputTokens, outputTokens };
    },
    renderVerdict: async () => {
      throw new Error('not used in this demo');
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-cross-provider-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
  const anthropicProvider = fakeProvider('anthropic', 500, 300);
  const openaiProvider = fakeProvider('openai', 500, 300);
  const client = new ScripClient(runtime, { anthropic: anthropicProvider, openai: openaiProvider });

  const task = await authorizeTask(runtime, {
    budget: 'cross_provider_demo',
    taskId: `cross-provider-demo-${Date.now()}`,
    task: 'Compare a Claude call and a GPT call under the same task lease',
    allowance: 1,
  });
  console.log(`Task authorized: $${task.authorization.allowance.toFixed(4)} allowance on cross_provider_demo\n`);

  const claudeResult = await client.run({
    credential: task.credential,
    model: 'claude-sonnet-5',
    estimatedInputTokens: 500,
    maxTokens: 300,
    messages: [{ role: 'user', content: 'Summarize point 1.' }],
  });
  console.log(
    `[RAN] model=${claudeResult.model} cost=$${claudeResult.actualCost.toFixed(6)} ` +
      `-> anthropic provider calls=${anthropicProvider.calls}, openai provider calls=${openaiProvider.calls}`
  );

  const gptResult = await client.run({
    credential: task.credential,
    model: 'gpt-5.6-luna',
    estimatedInputTokens: 500,
    maxTokens: 300,
    messages: [{ role: 'user', content: 'Summarize point 2.' }],
  });
  console.log(
    `[RAN] model=${gptResult.model} cost=$${gptResult.actualCost.toFixed(6)} ` +
      `-> anthropic provider calls=${anthropicProvider.calls}, openai provider calls=${openaiProvider.calls}\n`
  );

  const receipt = await settleTask(runtime, task.authorization.authorizationId, {
    status: 'success',
    evidence: 'One Claude call and one GPT call both enforced by the same task lease',
  });

  console.log('Final receipt, one task lease spanning two providers:');
  console.log(JSON.stringify(receipt.modelUsage, null, 2));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
