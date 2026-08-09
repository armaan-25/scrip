import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScripRuntime } from '../src/runtime.js';

// Unlike visuals/agent-card-live-server.ts (MockCardIssuer, offline-safe),
// this one loads .env and does NOT override ScripRuntime's gateway/card
// issuer - so it picks up whatever createRampGateway()/createCardIssuer()
// resolve to for real, same as the CLI or HTTP server would. With
// RAMP_CLI_BIN set (see .env.example), that's a real Ramp OAuth/Fund
// gateway and RampCliCardIssuer - live-verified 2026-08-08 to mint an
// actual single-use Ramp Agent Card (real pan/cvv/expiration) by shelling
// out to the real `ramp-cli` binary. Same "standalone visualization"
// separation from src/interfaces/http/server.ts as every other visuals
// server - this is instrumentation, not the product surface.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8796);

type StreamEvent =
  | { type: 'authorized'; allowance: number; budget: string }
  | { type: 'reserving'; label: string; maximumCost: number; merchant: string }
  | { type: 'card_minted'; cardId: string; last4: string; state: string }
  | { type: 'committed'; actualCost: number }
  | { type: 'settled'; authorized: number; actual: number; returned: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(send: (event: StreamEvent) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-card-real-'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'ramp.json'), undefined, path.join(tmpDir, 'leases.json'));

  const task = await runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: `card-real-${Date.now()}`,
    task: 'License a third-party dataset for benchmarking',
    allowance: 5,
  });
  send({ type: 'authorized', allowance: 5, budget: 'research' });
  await sleep(600);

  const label = 'vendor_dataset_license';
  const maximumCost = 0.01;
  const merchant = 'example.com';
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

  const actualCost = maximumCost;
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

  if (req.url === '/' || req.url === '/agent-card-real.html') {
    const html = fs.readFileSync(path.join(__dirname, 'agent-card-real.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[visuals] REAL agent-card tracker: http://localhost:${PORT}`);
});
