import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ScripRuntime } from '../src/runtime.js';
import { AgentTrackRecordStore, MockRampGateway } from '../src/store.js';

// The "landing page" reimagining: one task at the top with its allocated
// budget, a live list of sub-agents it has delegated slices of that budget
// to, and (unlike every other visuals/ page, which only shows Scrip's own
// state transitions) a click-through into a real Chrome tab each agent is
// actually driving via playwright-cli - proving the delegated authority is
// being spent on a real, navigable checkout, not just a domain-object.
//
// Two independent things run in this one process:
//  1. The Scrip domain scenario (authorizeTask -> delegate -> reserveAction),
//     same MockRampGateway pattern as live-server.ts, streamed over /events.
//  2. Per-agent browser sessions via `pw`, one named session per agentId,
//     lazily launched the first time a browser pane is opened, polled for
//     screenshots over /agent/:id/stream. Deliberately not a real video/CDP
//     screencast - pw only exposes point-in-time `screenshot`, so this polls
//     the same primitive the browser-automation skill uses on an interval.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);
const PW_AGENT_DIR = path.join(os.homedir(), '.pw-agent');
const PW_BIN = path.join(PW_AGENT_DIR, 'pw');

type StreamEvent =
  | { type: 'authorized'; taskId: string; allowance: number; budget: string }
  | { type: 'delegated'; agentId: string; allowance: number; requested: number; label: string; storeUrl: string }
  | { type: 'committed'; agentId: string; actualCost: number }
  | { type: 'denied'; agentId: string; requested: number; reason: string }
  | { type: 'lease_settled'; agentId: string; outcome: string; resolveRate: number; resolvedCount: number; totalCount: number }
  | { type: 'clamped'; agentId: string; requested: number; granted: number; resolveRate: number }
  | { type: 'settled'; authorized: number; actual: number; returned: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STORE_URL = 'https://www.saucedemo.com/';

// research budget caps allowance at $10 (scrip.yaml max_task_allowance) -
// scaled to fit. tableware asks for the same $4 as the others but has a bad
// track record (see seedTrackRecord) - delegate() clamps it to a token
// amount before the pool is ever the binding constraint, and it commits
// successfully at that tiny amount rather than being denied outright.
const AGENTS: Array<{ agentId: string; label: string; delegate: number; actual: number }> = [
  { agentId: 'agent-balloons', label: 'Balloons & decorations', delegate: 4, actual: 3.25 },
  { agentId: 'agent-snacks', label: 'Snacks & drinks', delegate: 4, actual: 3.7 },
  { agentId: 'agent-tableware', label: 'Tableware & extras', delegate: 4, actual: 4 }, // clamped well below this by adaptive cap
];

// Stable for this server process's lifetime (not per-run, unlike the rest
// of the scenario's tmpDir) - the whole point of the adaptive cap is that
// an agentId's trust is earned across *separate* authorizations, so its
// history has to outlive any single runScenario() call. Reset on server
// restart, accumulates across repeated page loads within one run.
const TRACK_RECORD_PATH = path.join(os.tmpdir(), 'scrip-console-track-record', 'track-record.json');
fs.rmSync(path.dirname(TRACK_RECORD_PATH), { recursive: true, force: true });
const trackRecord = new AgentTrackRecordStore(TRACK_RECORD_PATH);

const FLAKY_AGENT_ID = 'agent-tableware';

/**
 * Gives agent-tableware a bad track record *before* the real party-supplies
 * delegation runs, so that delegation visibly gets clamped instead of just
 * failing on budget like before - three quick failed micro-purchases on a
 * throwaway root task, each settled via settleLease() (independent of that
 * task's own settleTask()), which is what research's
 * min_settlements_for_trust: 3 / low_trust_resolve_rate_threshold: 0.5
 * actually reads from. Off to the side of the main pool so it doesn't
 * consume any of the $10 the visible task authorizes.
 */
async function seedTrackRecord(runtime: ScripRuntime, send: (event: StreamEvent) => void) {
  const seedTask = await runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId: `seed-${Date.now()}`,
    task: 'Prior tableware orders (history)',
    allowance: 3,
  });
  for (let i = 0; i < 3; i++) {
    const child = runtime.authorizations.delegate(seedTask.credential, FLAKY_AGENT_ID, 0.5);
    runtime.authorizations.settleLease(child.lease.leaseId, 'failure');
    const rate = trackRecord.getResolveRate(FLAKY_AGENT_ID);
    send({
      type: 'lease_settled',
      agentId: FLAKY_AGENT_ID,
      outcome: 'failure',
      resolveRate: rate.rate,
      resolvedCount: rate.resolved,
      totalCount: rate.total,
    });
    await sleep(250);
  }
  await runtime.authorizations.settleTask(seedTask.authorization.authorizationId, { status: 'failure' });
}

async function runScenario(send: (event: StreamEvent) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-console-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp, undefined, TRACK_RECORD_PATH);

  await seedTrackRecord(runtime, send);
  await sleep(500);

  const taskId = `console-${Date.now()}`;
  const allowance = 10;
  const task = await runtime.authorizations.authorizeTask({
    budget: 'research',
    taskId,
    task: 'Buy party supplies for the office event',
    allowance,
  });
  send({ type: 'authorized', taskId, allowance, budget: 'research' });
  await sleep(600);

  for (const agent of AGENTS) {
    await sleep(750);
    try {
      const requested = agent.delegate;
      const child = runtime.authorizations.delegate(task.credential, agent.agentId, requested);
      const granted = child.lease.allowance;
      send({ type: 'delegated', agentId: agent.agentId, allowance: granted, requested, label: agent.label, storeUrl: STORE_URL });
      if (granted < requested) {
        const rate = trackRecord.getResolveRate(agent.agentId);
        send({ type: 'clamped', agentId: agent.agentId, requested, granted, resolveRate: rate.rate });
      }
      await sleep(550);
      const actualCost = Math.min(agent.actual, granted);
      const reservation = runtime.authorizations.reserveAction(child.credential, 'purchase', agent.label, granted);
      runtime.authorizations.commitAction(reservation.reservationId, actualCost);
      runtime.authorizations.settleLease(child.lease.leaseId, 'success');
      send({ type: 'committed', agentId: agent.agentId, actualCost });
    } catch (error) {
      send({
        type: 'denied',
        agentId: agent.agentId,
        requested: agent.delegate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await sleep(700);
  const receipt = await runtime.authorizations.settleTask(task.authorization.authorizationId, {
    status: 'success',
    evidence: 'Supplies ordered for the office event',
  });
  send({ type: 'settled', authorized: receipt.authorized, actual: receipt.actual, returned: receipt.returned });

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function execPw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PW_BIN, args, { cwd: PW_AGENT_DIR, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

// playwright-cli's daemon exposes one control socket per -s=<name> session.
// Two commands against the *same* session racing (e.g. this endpoint polled
// from two tabs, or a stream whose client disconnected without the server
// noticing yet) collide on that socket and the second one fails with a raw
// `listen EINVAL` - live-reproduced while recording the demo, and not
// dependent on session name length as first suspected. Serialize all pw
// calls per session so only one is ever in flight at a time.
const pwQueues = new Map<string, Promise<unknown>>();

function runPw(session: string, args: string[]): Promise<string> {
  const prior = pwQueues.get(session) ?? Promise.resolve();
  const next = prior.then(() => execPw(args), () => execPw(args));
  pwQueues.set(session, next);
  return next as Promise<string>;
}

// playwright-cli also names its control socket file after -s=<name>, and
// macOS caps sockaddr_un paths at 104 bytes - keep session names short and
// fixed-length regardless of how descriptive agentId gets.
function pwSessionName(agentId: string): string {
  return createHash('sha1').update(agentId).digest('hex').slice(0, 10);
}

const launchedSessions = new Map<string, string>(); // agentId -> pw session name

// Matches the .browser-frame pane's actual shape - narrow (min(560px,46vw))
// and tall (full pane height), not a normal landscape window. pw's default
// window landed only its top-left corner in the pane; a landscape 720x480
// fixed the crop but then letterboxed with a large empty gap below the
// image (object-fit: contain centers/pads a wide image in a tall box).
// Sizing the real browser window to the pane's own portrait proportions
// makes screenshots fill it edge to edge instead of relying on CSS to
// reconcile two different aspect ratios.
const AGENT_BROWSER_SIZE = { width: 540, height: 860 };

async function ensureAgentSession(agentId: string, storeUrl: string): Promise<string> {
  const existing = launchedSessions.get(agentId);
  if (existing) return existing;
  const session = pwSessionName(agentId);
  await runPw(session, [`-s=${session}`, 'open', storeUrl]);
  await runPw(session, [`-s=${session}`, 'resize', String(AGENT_BROWSER_SIZE.width), String(AGENT_BROWSER_SIZE.height)]);
  launchedSessions.set(agentId, session);
  return session;
}

function latestScreenshot(): { file: string; mtimeMs: number } | null {
  const dir = path.join(PW_AGENT_DIR, '.playwright-cli');
  if (!existsSync(dir)) return null;
  const pngs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const full = path.join(dir, f);
      return { file: full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pngs[0] ?? null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/events') {
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

  // Per-agent live browser pane: lazily launches a named pw session against
  // the demo storefront, then streams a fresh screenshot every ~1.2s as a
  // data: URL so the client can just point an <img> at each event.
  const agentStreamMatch = url.pathname.match(/^\/agent\/([\w-]+)\/stream$/);
  if (agentStreamMatch) {
    const agentId = agentStreamMatch[1];
    const storeUrl = url.searchParams.get('store') ?? STORE_URL;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    try {
      const session = await ensureAgentSession(agentId, storeUrl);
      send({ type: 'ready', agentId, storeUrl });

      while (!closed) {
        await runPw(session, [`-s=${session}`, 'screenshot']);
        const shot = latestScreenshot();
        if (shot) {
          const b64 = fs.readFileSync(shot.file).toString('base64');
          send({ type: 'frame', agentId, dataUrl: `data:image/png;base64,${b64}` });
        }
        await sleep(1200);
      }
    } catch (error) {
      send({ type: 'error', agentId, message: error instanceof Error ? error.message : String(error) });
    }
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/console.html') {
    const html = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

process.on('SIGINT', async () => {
  for (const session of launchedSessions.values()) {
    try {
      await runPw(session, [`-s=${session}`, 'close']);
    } catch {
      // best-effort cleanup
    }
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[visuals] console: http://localhost:${PORT}`);
});
