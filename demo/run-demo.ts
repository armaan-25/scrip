import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import Anthropic from '@anthropic-ai/sdk';
import { authorizeTask, delegateTaskAllowance, settleTask } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';

async function main() {
  const runtime = new ScripRuntime('scrip.yaml', '.scrip/ramp.json');
  const client = new ScripClient(runtime, new Anthropic());
  const task = await authorizeTask(runtime, {
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

  const receipt = await settleTask(runtime, task.authorization.authorizationId);
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
