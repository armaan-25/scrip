import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { loadConfig } from '../src/config.js';
import { createCardIssuer } from '../src/runtime.js';

// Tests whichever CardIssuer createCardIssuer() picks based on current env
// vars (RampCliCardIssuer if RAMP_CLI_BIN is set - the one that mints real
// Ramp Agent Cards, live-verified 2026-08-08 - else RampAgentCardIssuer if
// RAMP_CARDHOLDER_USER_ID is set, which mints a real Vault API card, a
// different Ramp product; see docs/ramp-api-notes.md's "Card issuance"
// section for why those are not the same thing).
async function main() {
  const issuer = createCardIssuer();
  console.log('Issuer type:', issuer.constructor.name);
  if (issuer.constructor.name === 'MockCardIssuer') {
    console.error('Neither RAMP_CLI_BIN nor RAMP_CARDHOLDER_USER_ID set - nothing real to test.');
    process.exit(1);
  }

  const fundId = loadConfig('scrip.yaml').budgets.research?.rampFundId;
  const card = await issuer.issueCard({
    displayName: 'scrip-smoke-test-card',
    maximumAmountUsd: 0.01,
    merchant: 'smoke-test',
    fundId,
  });
  console.log('Real card minted:', card);
}

main().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
