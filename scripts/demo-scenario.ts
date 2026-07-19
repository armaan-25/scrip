import { authorizeTask, delegateTaskAllowance, settleTask } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, no API key required: a fake Anthropic client returns fixed
// token usage instead of making a real network call, so this script is
// reproducible and free to run, while exercising the real
// TaskAuthorizationManager/ScripClient enforcement code paths.
function fakeAnthropic(inputTokens: number, outputTokens: number) {
  return {
    messages: {
      create: async () => ({
        id: 'msg_demo',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        content: [{ type: 'text', text: 'ok' }],
      }),
    },
  } as any;
}

interface AgentOutcome {
  agentId: string;
  requestedAllowance: number;
  status: 'ran' | 'denied';
  reason?: string;
  model?: string;
  actualCost?: number;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-demo-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
  const client = new ScripClient(runtime, fakeAnthropic(400, 250));

  const taskAllowance = 0.05;
  const task = await authorizeTask(runtime, {
    budget: 'research',
    taskId: `demo-${Date.now()}`,
    task: 'Research authentication libraries across five parallel agents',
    allowance: taskAllowance,
  });

  console.log(`Task authorized: $${taskAllowance.toFixed(4)} allowance, credential ${task.credential.slice(0, 16)}...`);
  console.log('');

  // Five subagents each ask for an equal 1/4 share (5 x 1/4 > 1, so this
  // intentionally oversubscribes the task). Each agent delegates its own
  // child credential and immediately runs against the real proxy in one
  // pass, so every denial below reflects live enforcement, not a scripted
  // outcome.
  const requestedShare = taskAllowance / 4;
  const outcomes: AgentOutcome[] = [];

  for (let i = 1; i <= 5; i++) {
    const agentId = `researcher-${i}`;
    try {
      const child = delegateTaskAllowance(runtime, {
        parentCredential: task.credential,
        agentId,
        allowance: requestedShare,
      });
      const result = await client.run({
        credential: child.credential,
        estimatedInputTokens: 400,
        maxTokens: 250,
        messages: [{ role: 'user', content: `Summarize a finding for ${agentId}.` }],
      });
      outcomes.push({
        agentId,
        requestedAllowance: requestedShare,
        status: 'ran',
        model: result.model,
        actualCost: result.actualCost,
      });
    } catch (error) {
      outcomes.push({
        agentId,
        requestedAllowance: requestedShare,
        status: 'denied',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log('Five subagents, each requesting an equal 1/4 share of the task allowance:');
  for (const o of outcomes) {
    if (o.status === 'ran') {
      console.log(`  [RAN]    ${o.agentId}: model=${o.model} actualCost=$${o.actualCost!.toFixed(6)}`);
    } else {
      console.log(`  [DENIED] ${o.agentId}: ${o.reason}`);
    }
  }
  console.log('');

  const ranCount = outcomes.filter((o) => o.status === 'ran').length;
  const receipt = await settleTask(runtime, task.authorization.authorizationId, {
    status: 'success',
    evidence: `${ranCount} of 5 requested subagents completed within budget; the rest were denied before any provider call`,
  });

  console.log('Final receipt:');
  console.log(JSON.stringify(receipt, null, 2));

  fs.writeFileSync(
    path.join(process.cwd(), 'scripts', 'demo-scenario-output.json'),
    JSON.stringify({ taskAllowance, requestedShare, outcomes, receipt }, null, 2)
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
