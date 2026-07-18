import Anthropic from '@anthropic-ai/sdk';
import { authorizeTask, delegateTaskAllowance, settleTask } from '../src/handlers.js';
import { SpecSpendClient } from '../src/proxy.js';
import { SpecSpendRuntime } from '../src/runtime.js';

async function main() {
  const runtime = new SpecSpendRuntime('specspend.yaml', '.specspend/ramp.json');
  const client = new SpecSpendClient(runtime, new Anthropic());
  const task = authorizeTask(runtime, {
    budget: 'research',
    taskId: `research-${Date.now()}`,
    task: 'Research authentication libraries in this repository',
    allowance: 1,
  });

  console.log(`Task credential issued with $${task.authorization.allowance.toFixed(2)} allowance`);
  const children = [1, 2].map((agent) =>
    delegateTaskAllowance(runtime, {
      parentCredential: task.credential,
      agentId: `researcher-${agent}`,
      allowance: 0.4,
    })
  );

  await Promise.all(
    children.map((child, index) =>
      client.run({
        credential: child.credential,
        estimatedInputTokens: 500,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: `Summarize authentication library practices, focusing on aspect ${index + 1}.`,
          },
        ],
      })
    )
  );

  const receipt = settleTask(runtime, task.authorization.authorizationId);
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
