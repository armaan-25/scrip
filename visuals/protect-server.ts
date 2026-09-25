/**
 * Serves the purchase-protection demo as one page. Runs runProtectDemo()
 * once per /events connection and streams its timeline step by step, then
 * the result object over node:http as server-sent events, with one static
 * HTML file. The card, issuer and merchants are SIMULATED. With
 * SCRIP_RAIL=natural, every page load also makes real $1.00 transfers on
 * the Natural account behind NATURAL_API_KEY (swept back each run).
 *
 * Run: npm run visuals:protect   (PORT defaults to 8798)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedBooking, driftedBooking, runProtectDemo } from '../demo/protect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8798);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 350);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'protect.html')));
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('fixture', { approved: approvedBooking, drifted: driftedBooking });
    send('rail', { rail: process.env.SCRIP_RAIL === 'natural' ? 'natural' : 'simulated' });
    try {
      const result = await runProtectDemo(() => {});
      send('approval', result.approval);
      for (const step of result.timeline) {
        if (req.destroyed) return;
        send('step', step);
        await sleep(STEP_DELAY_MS);
      }
      send('result', { correct: result.correct, violations: result.violations, orderMismatch: result.orderMismatch, noIntegration: result.noIntegration });
      send('done', {});
    } catch (error) {
      send('error', { message: (error as Error).message });
    }
    res.end();
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`Scrip purchase-protection demo: http://localhost:${PORT}`);
});
