import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

// Same "standalone visualization, deliberately separate from the real
// product surface" pattern as live-server.ts, reshaped for the one flow
// that has no visualization yet: reserveCardPurchase() minting a real
// Ramp Agent Card. Runs against MockCardIssuer (no RAMP_CARDHOLDER_USER_ID
// set in this environment) so this stays offline-safe like agents-live.html
// - a real RampAgentCardIssuer run belongs in scripts/smoke-test-agent-card.ts,
// not a browser demo, per docs/ramp-api-notes.md's "not yet live-verified"
// note on that integration.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);

type StreamEvent =
  | { type: 'authorized'; allowance: number; budget: string }
  | { type: 'reserving'; label: string; maximumCost: number; merchant: string }
  | { type: 'card_minted'; cardId: string; last4: string; state: string }
  | { type: 'committed'; actualCost: number }
  | { type: 'settled'; authorized: number; actual: number; returned: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one real task against real TaskAuthorizationManager.reserveCardPurchase()
 * code - the same call a worker would make to buy something with a real
 * payment instrument, not a metering record.
 */
async function runScenario(send: (event: StreamEvent) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-card-live-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);

  const task = await runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: `card-live-${Date.now()}`,
    task: 'License a third-party dataset for benchmarking',
    allowance: 5,
  });
  send({ type: 'authorized', allowance: 5, budget: 'research' });
  await sleep(600);

  const label = 'vendor_dataset_license';
  const maximumCost = 2.5;
  const merchant = 'data-vendor.example';
  send({ type: 'reserving', label, maximumCost, merchant });
  await sleep(700);

  const reservation = await runtime.authorizations.reserveCardPurchase(task.credential, label, maximumCost, {
    merchant,
  });
  send({
    type: 'card_minted',
    cardId: reservation.card.cardId,
    last4: reservation.card.last4,
    state: reservation.card.state,
  });
  await sleep(800);

  const actualCost = 1.9;
  runtime.authorizations.commitAction(reservation.reservationId, actualCost);
  send({ type: 'committed', actualCost });
  await sleep(700);

  const receipt = await runtime.authorizations.settleTask(task.authorization.authorizationId, {
    status: 'success',
    evidence: 'Dataset license delivered, benchmark run completed',
  });
  send({ type: 'settled', authorized: receipt.authorized, actual: receipt.actual, returned: receipt.returned });

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (event: StreamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await runScenario(send);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n\n`);
    }
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/agent-card-live.html') {
    const html = fs.readFileSync(path.join(__dirname, 'agent-card-live.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[visuals] live agent-card tracker: http://localhost:${PORT}`);
});
