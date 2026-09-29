/**
 * Live page for the flight trace demo. Click Run: the three scripted agents
 * run (offline, or on Natural's sandbox with SCRIP_RAIL=sandbox) and every
 * recorded step streams to the browser as it happens, over server-sent events.
 *
 * Run: npm run ui   (PORT defaults to 8799). Local only.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlightTraceDemo } from '../demo/flight-trace.js';
import { renderTimeline } from '../src/trace/timeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);
const defaultMode = process.env.SCRIP_RAIL === 'sandbox' ? 'sandbox' : 'offline';
let running = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'trace.html')));
    return;
  }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ defaultMode, sandboxAvailable: Boolean(process.env.NATURAL_SANDBOX_API_KEY && process.env.NATURAL_SANDBOX_AGENT_KEY) }));
    return;
  }
  if (url.pathname === '/run') {
    if (running) { res.writeHead(409); res.end('A run is already in progress'); return; }
    const mode = url.searchParams.get('mode') === 'sandbox' ? 'sandbox' : 'offline';
    running = true;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await runFlightTraceDemo({
        mode,
        log: line => { if (line && !line.startsWith('  ') && !line.startsWith('──')) send('log', { line }); },
        onEvent: (scenario, e) => send('step', { scenario, type: e.type, at: e.at, line: renderTimeline([e])[0], data: e.data }),
      });
      send('done', result);
    } catch (error) {
      send('error', { message: (error as Error).message });
    } finally {
      running = false;
      res.end();
    }
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`Scrip trace page: http://localhost:${PORT}  (default mode: ${defaultMode})`));
