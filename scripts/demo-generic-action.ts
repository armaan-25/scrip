import { authorizeTask, settleTask } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, no API key required: proves the same task lease that
// gates a real Anthropic call can also gate an unrelated paid API call,
// with the same atomicity guarantees, no new infrastructure - the narrow
// proof of "economic control plane," not the full multi-rail vision.
function fakeProvider(inputTokens: number, outputTokens: number) {
  return {
    createMessage: async () => ({ content: 'ok', inputTokens, outputTokens }),
    renderVerdict: async () => {
      throw new Error('not used in this demo');
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-generic-action-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
  const provider = fakeProvider(500, 300);
  const client = new ScripClient(runtime, { anthropic: provider, openai: provider });

  const task = await authorizeTask(runtime, {
    budget: 'research',
    taskId: `generic-action-demo-${Date.now()}`,
    task: 'Research authentication vendors and check a paid comparison API',
    allowance: 0.5,
  });
  console.log(`Task authorized: $${task.authorization.allowance.toFixed(4)} allowance\n`);

  // A real inference call through ScripClient - unchanged from every other demo.
  const inferenceResult = await client.run({
    credential: task.credential,
    estimatedInputTokens: 500,
    maxTokens: 300,
    messages: [{ role: 'user', content: 'Summarize the top 3 auth vendors.' }],
  });
  console.log(`[RAN inference] model=${inferenceResult.model} cost=$${inferenceResult.actualCost.toFixed(6)}`);

  // A non-inference action - no model, no token counts, just a labeled cost -
  // reserved and committed through the exact same lease, using the generic
  // primitive directly (reserveAction/commitAction, not reserveRequest/commitRequest).
  const apiReservation = runtime.authorizations.reserveAction(
    task.credential,
    'paid_api',
    'vendor_comparison_api',
    0.05
  );
  console.log(`[RESERVED paid_api] label=${apiReservation.label} maxCost=$${apiReservation.maximumCost.toFixed(4)}`);
  // ... the real paid API call would happen here ...
  const actualApiCost = 0.031;
  runtime.authorizations.commitAction(apiReservation.reservationId, actualApiCost);
  console.log(`[RAN paid_api] label=${apiReservation.label} cost=$${actualApiCost.toFixed(6)}\n`);

  const receipt = await settleTask(runtime, task.authorization.authorizationId, {
    status: 'success',
    evidence: 'Vendor comparison completed using both inference and a paid data API',
  });

  console.log('Final receipt, broken down by action type:');
  console.log(JSON.stringify({ actual: receipt.actual, actionUsage: receipt.actionUsage, modelUsage: receipt.modelUsage }, null, 2));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
