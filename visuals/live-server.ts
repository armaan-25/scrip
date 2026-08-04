import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

// A standalone visualization server, deliberately separate from
// src/interfaces/http/server.ts - that file's whole point is "no business
// logic, no demo instrumentation, three thin surfaces one core." This one
// runs the exact same real TaskAuthorizationManager code, but instruments
// it to stream real state transitions to a browser as they happen, which
// the real product API has no reason to do.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8798);

type StreamEvent =
  | { type: 'authorized'; allowance: number; budget: string }
  | { type: 'delegated'; agentId: string; allowance: number }
  | { type: 'committed'; agentId: string; actualCost: number }
  | { type: 'denied'; agentId: string; requested: number; reason: string }
  | { type: 'settled'; authorized: number; actual: number; returned: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one real task against real TaskAuthorizationManager code - the exact
 * same delegate()/reserveAction()/commitAction() calls demo-flagship.ts
 * exercises - pacing each step with a short real delay so it's watchable,
 * and pushing every real state transition to `send` as it actually occurs.
 */
async function runScenario(send: (event: StreamEvent) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-live-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);

  const task = await runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: `live-${Date.now()}`,
    task: 'Review PR 418',
    allowance: 10,
  });
  send({ type: 'authorized', allowance: 10, budget: 'research' });
  await sleep(600);

  const workers: Array<{ agentId: string; delegate: number; actual: number }> = [
    { agentId: 'worker-anthropic', delegate: 4, actual: 3.2 },
    { agentId: 'worker-openai', delegate: 4, actual: 3.8 },
    { agentId: 'worker-paid-api', delegate: 4, actual: 0 }, // denied - only $2 left after the two above
  ];

  for (const worker of workers) {
    await sleep(750);
    try {
      const child = runtime.authorizations.delegate(task.credential, worker.agentId, worker.delegate);
      send({ type: 'delegated', agentId: worker.agentId, allowance: worker.delegate });
      await sleep(550);
      const reservation = runtime.authorizations.reserveAction(child.credential, 'inference', 'claude-sonnet-5', worker.delegate);
      runtime.authorizations.commitAction(reservation.reservationId, worker.actual);
      send({ type: 'committed', agentId: worker.agentId, actualCost: worker.actual });
    } catch (error) {
      send({
        type: 'denied',
        agentId: worker.agentId,
        requested: worker.delegate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await sleep(700);
  const receipt = await runtime.authorizations.settleTask(task.authorization.authorizationId, {
    status: 'success',
    evidence: 'PR 418 merged, tests passing',
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
      send({ type: 'denied', agentId: 'scenario', requested: 0, reason: error instanceof Error ? error.message : String(error) });
    }
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/agents-live.html') {
    const html = fs.readFileSync(path.join(__dirname, 'agents-live.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[visuals] live agent tracker: http://localhost:${PORT}`);
});
