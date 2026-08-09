import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { ScripRuntime } from '../src/runtime.js';

// Full-stack live verification of reserveCardPurchase() - not just
// CardIssuer.issueCard() in isolation (see smoke-test-agent-card.ts), but
// the real authorizeTask() -> reserveCardPurchase() path through
// TaskAuthorizationManager, exactly as any real caller would use it.
// Live-verified 2026-08-08 with RAMP_CLI_BIN set: mints a real Ramp Agent
// Card. Requires the reservation's budget (default: research) to have a
// ramp_fund_id in scrip.yaml that is itself enrolled for agent card
// payments - check with `ramp funds get-agent-card-funds`, not every fund
// is.
async function main() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'scrip-card-purchase-'));
  try {
    const runtime = new ScripRuntime(
      'scrip.yaml',
      path.join(tmpDir, 'ramp.json'),
      undefined,
      path.join(tmpDir, 'leases.json')
    );

    const task = await runtime.authorizations.authorizeTask({
      budget: 'research',
      taskId: `card-purchase-smoke-test-${Date.now()}`,
      task: 'License a dataset',
      allowance: 5,
    });
    console.log('authorized:', task.authorization.allowance);

    const reservation = await runtime.authorizations.reserveCardPurchase(
      task.credential,
      'vendor_dataset_license',
      0.01,
      { merchant: 'example.com' }
    );
    console.log('card minted:', {
      cardId: reservation.card.cardId,
      last4: reservation.card.last4,
      state: reservation.card.state,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
