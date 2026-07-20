import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { createRampGateway } from '../src/runtime.js';
import type { ScripConfig } from '../src/config.js';

const config: ScripConfig = {
  team: 'agent-platform',
  rampEntityId: 'ramp-entity-demo',
  budgets: {
    research: {
      rampBudgetId: 'ramp-budget-research',
      rampFundId: process.env.RAMP_RESEARCH_FUND_ID,
      monthlyLimit: 100,
      maxTaskAllowance: 10,
      allowedModels: [],
      fallbackModel: '',
      onLimit: 'deny',
      taskTtlSeconds: 900,
      costCenter: '',
      maxDelegationDepth: 3,
      minRequestInputTokens: 500,
      minRequestOutputTokens: 200,
    },
  },
};

async function main() {
  const gateway = createRampGateway('/tmp/scrip-smoke-store.json', config);
  console.log('Gateway type:', gateway.constructor.name);
  const spend = await gateway.getReportedSpend('ramp-budget-research');
  console.log('Real reported spend for research budget (Software fund):', spend);
}

main().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
