import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { Meter } from '../src/meter.js';
import type { TaskReceipt } from '../src/store.js';

async function main() {
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';

  if (!clientId || !clientSecret) {
    throw new Error('RAMP_CLIENT_ID/RAMP_CLIENT_SECRET must be set in .env to run this smoke test');
  }

  const meter = new Meter({ clientId, clientSecret, baseUrl, source: 'scrip' });

  const receipt: TaskReceipt = {
    receiptId: `smoke-test-${Date.now()}`,
    authorizationId: `smoke-auth-${Date.now()}`,
    rampEntityId: 'ramp-entity-demo',
    rampBudgetId: 'ramp-budget-research',
    team: 'agent-platform',
    taskId: `meter-smoke-${Date.now()}`,
    task: 'Meter live broadcast smoke test',
    authorized: 0.5,
    actual: 0.02,
    returned: 0.48,
    childAgents: 0,
    requestCount: 1,
    modelUsage: [{ model: 'claude-sonnet-5', requests: 1, inputTokens: 500, outputTokens: 300, cost: 0.02 }],
    actionUsage: [{ actionType: 'inference', count: 1, cost: 0.02 }],
    costCenter: 'AI compute',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    settledAt: new Date().toISOString(),
    outcome: 'success',
    outcomeEvidence: 'Meter live smoke test',
  };

  console.log('Broadcasting a real receipt to ai-usage/unified...');
  await meter.reportUsage(receipt);
  console.log('Success: Ramp accepted the broadcast (204 No Content expected, no error thrown).');
}

main().catch((error) => {
  console.error('Meter smoke test FAILED:', error);
  process.exit(1);
});
