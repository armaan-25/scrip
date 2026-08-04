import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { createCardIssuer } from '../src/runtime.js';

async function main() {
  const issuer = createCardIssuer();
  console.log('Issuer type:', issuer.constructor.name);
  if (issuer.constructor.name === 'MockCardIssuer') {
    console.error('RAMP_CLIENT_ID/RAMP_CLIENT_SECRET/RAMP_CARDHOLDER_USER_ID not all set - nothing real to test.');
    process.exit(1);
  }

  const card = await issuer.issueCard({
    displayName: 'scrip-smoke-test-agent-card',
    maximumAmountUsd: 0.01,
    merchant: 'smoke-test',
  });
  console.log('Real card minted:', card);
}

main().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
