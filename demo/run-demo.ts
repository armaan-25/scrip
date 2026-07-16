import Anthropic from '@anthropic-ai/sdk';
import { SpendSpecRuntime } from '../src/runtime.js';
import { SpendSpecClient } from '../src/proxy.js';

async function main() {
  const runtime = new SpendSpecRuntime('spendspec.yaml', '.spendspec/store.json');
  const anthropic = new Anthropic();
  const client = new SpendSpecClient(runtime, anthropic);

  const project = 'research-agent';
  const feature = 'default';

  const remainingBefore = runtime.leaseManager.getRemainingBudget(project, feature);
  console.log(`Remaining monthly budget: $${remainingBefore.toFixed(2)}`);

  const plannedAgents = 5;
  const perAgentEstimate = 0.5; // dollars, rough per-agent estimate at premium model rates
  const plannedCost = plannedAgents * perAgentEstimate;
  console.log(`Estimated cost with ${plannedAgents} agents: $${plannedCost.toFixed(2)}`);

  const revisedAgents = plannedCost > remainingBefore ? 2 : plannedAgents;
  console.log(`Revised plan: use ${revisedAgents} agents`);

  const task = 'Research authentication libraries in this repository';
  const results = await Promise.all(
    Array.from({ length: revisedAgents }, (_, i) =>
      client.run({
        project,
        feature,
        task: `${task} (agent ${i + 1})`,
        team: runtime.config.team,
        costCenter: 'Product COGS',
        estimatedInputTokens: 500,
        estimatedOutputTokens: 300,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: `Summarize best practices for authentication libraries, focusing on aspect ${i + 1}.`,
          },
        ],
      })
    )
  );

  const totalActual = results.reduce((sum, r) => sum + r.actualCost, 0);
  console.log(`Authorized: $${remainingBefore.toFixed(2)}`);
  console.log(`Spent: $${totalActual.toFixed(4)}`);
  console.log(`Saved against initial plan: $${(plannedCost - totalActual).toFixed(4)}`);
  results.forEach((r, i) =>
    console.log(`  agent ${i + 1}: model=${r.model} cost=$${r.actualCost.toFixed(4)} degraded=${r.degraded}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
