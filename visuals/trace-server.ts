/**
 * Live page for Scrip. Two kinds of runs, both streamed to the browser as
 * they happen (server-sent events):
 *   /run        the three scripted agents (repeatable demo)
 *   /run-agent  a real Claude agent that searches, states its understanding,
 *               requests a purchase and pays through Scrip's tools on /mcp
 * /track-record returns each agent version's record across real-agent runs.
 *
 * Run: npm run ui   (PORT defaults to 8799). Local only.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlightTraceDemo } from '../demo/flight-trace.js';
import { findProfile, manifestFor, PROFILES } from '../src/agent/profiles.js';
import { runClaudeAgent } from '../src/agent/run-claude-agent.js';
import { type RunContext, ScripToolServer } from '../src/agent/tool-server.js';
import { loadConfig } from '../src/config.js';
import { confirmedRequirements, demoRequest } from '../src/flights/fixtures.js';
import { TaskAuthorizationManager } from '../src/lease.js';
import type { AuthenticatedAgent } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { setupRail } from '../src/rails/rail-setup.js';
import { renderTimeline } from '../src/trace/timeline.js';
import { trackRecords } from '../src/trace/track-record.js';
import { SqliteTraceStore } from '../src/trace/trace-store.js';
import { FlightTraceService } from '../src/trace/trace-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);
const defaultMode = process.env.SCRIP_RAIL === 'sandbox' ? 'sandbox' : 'offline';
let running = false;

// One shared world for real-agent runs, so the agent's tool calls and the page see the same records.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-ui-'));
const now = () => new Date();
const registry = new SqliteAgentRegistry(path.join(dir, 'agents.sqlite'));
const store = new SqliteTraceStore(path.join(dir, 'trace.sqlite'));
const config = loadConfig('scrip.yaml');
config.budgets.research.maxTaskAllowance = 1000;
config.budgets.research.monthlyLimit = 1_000_000;
const ledger = new TaskAuthorizationManager(config, { getReportedSpend: async () => 0, reportTaskUsage: async () => {} });
const service = new FlightTraceService({ store, registry, ledger, budget: 'research', now });
const contexts = new Map<string, RunContext>();
const tools = new ScripToolServer(service, contexts, line => console.log('[tools]', line));
const agents = new Map<string, { lineageId: string; versionId: string; auth: AuthenticatedAgent }>();

function agentFor(profileId: string) {
  const cached = agents.get(profileId);
  if (cached) return cached;
  const profile = findProfile(profileId);
  if (!profile) throw new Error(`Unknown agent profile ${profileId}`);
  const lineage = registry.registerLineage({ ownerId: 'armaan', operator: 'scrip-demo', displayName: profile.label }, now());
  const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest: manifestFor(profile), registeredBy: 'armaan' }, now());
  const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());
  const entry = { lineageId: lineage.lineageId, versionId: version.versionId, auth: registry.authenticate(credential.credentialId, credential.secret, now()) };
  agents.set(profileId, entry);
  return entry;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += String(chunk); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

type Send = (event: string, data: unknown) => void;

/** What the person told the agent. Their confirmed requirements in Scrip are the same either way. */
const REQUESTS: Record<string, string> = {
  precise: demoRequest,
  vague: 'Get me the cheapest flight from NYC to SF, out Friday Oct 16, back Sunday Oct 18.',
};

async function runRealAgent(profileId: string, mode: 'offline' | 'sandbox', allowWeb: boolean, requestKind: string, send: Send) {
  const words = REQUESTS[requestKind] ?? demoRequest;
  const profile = findProfile(profileId);
  if (!profile) throw new Error(`Unknown agent profile ${profileId}`);
  const agent = agentFor(profileId);
  const scenario = `real:${profile.id}`;
  const rail = await setupRail(mode, `scrip-agent-${Date.now()}`);
  send('log', { line: mode === 'sandbox' ? `Live on Natural's sandbox. Agent ${rail.naturalAgentId} limited to 1 cent so every payment is held for Scrip.` : 'Offline: simulated Natural.' });
  send('log', { line: `Real agent: Claude (${profile.model}) as "${profile.label}"${allowWeb ? ', with web search' : ''}. The flight catalog and merchant are simulated.` });
  service.onEvent = e => send('step', { scenario, type: e.type, at: e.at, line: renderTimeline([e])[0], data: e.data });
  const traceId = service.start('armaan', words);
  try {
    const requirementsDigest = service.confirm(traceId, confirmedRequirements);
    const mandate = registry.createMandate({
      principalId: 'armaan', lineageId: agent.lineageId, authorizedVersionIds: [agent.versionId],
      fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
      outcomeContractDigest: requirementsDigest, changePolicy: 'require_approval', approvedBy: 'armaan', approvedAt: now().toISOString(),
    });
    contexts.set(traceId, { traceId, agent: agent.auth, mandateId: mandate.mandateId, rail });
    service.recordAgent(traceId, { type: 'agent_run_started', data: { agentVersionId: agent.versionId, profile: profile.id, model: profile.model } });

    const toolNames = new Map<string, string>();
    let final = { ok: false, turns: null as number | null, costUsd: null as number | null, summary: '' };
    const run = await runClaudeAgent({
      prompt: `Customer request: "${words}"`, systemPrompt: profile.instructions, model: profile.model,
      mcpUrl: `http://localhost:${PORT}/mcp`, traceId, allowWeb,
      onActivity: a => {
        if (a.kind === 'tool_call' && !a.internal) { toolNames.set(a.toolUseId, a.tool); service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: a.toolUseId, tool: a.tool, input: a.input } }); }
        if (a.kind === 'tool_result' && toolNames.has(a.toolUseId)) service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: a.toolUseId, tool: toolNames.get(a.toolUseId) ?? '?', output: a.output.slice(0, 2000), isError: a.isError } });
        if (a.kind === 'message') service.recordAgent(traceId, { type: 'agent_message', data: { text: a.text.slice(0, 2000) } });
        if (a.kind === 'final') final = { ok: a.ok, turns: a.turns, costUsd: a.costUsd, summary: a.text.slice(0, 2000) };
      },
    });
    if (run.exitCode !== 0 && !final.ok) send('log', { line: `Agent exited with code ${run.exitCode}. ${run.stderr.split('\n').slice(-3).join(' ')}` });
    service.recordAgent(traceId, { type: 'agent_run_finished', data: final });
  } finally {
    contexts.delete(traceId);
    service.onEvent = undefined;
    try { await rail.restore(); } catch (error) { send('log', { line: `WARNING: could not restore the sandbox agent's limit: ${(error as Error).message}` }); }
  }
  const events = service.events(traceId);
  const outcome = events.some(e => e.type === 'payment_settled' && e.data.status === 'COMPLETED') ? 'paid'
    : events.some(e => e.type === 'hold_decided' && e.data.decision === 'denied') ? 'denied_at_payment'
    : events.some(e => e.type === 'purchase_refused') ? 'blocked_before_payment' : 'undecided';
  return { scenarios: [{ name: scenario, traceId, outcome }] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'trace.html')));
    return;
  }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      defaultMode, sandboxAvailable: Boolean(process.env.NATURAL_SANDBOX_API_KEY && process.env.NATURAL_SANDBOX_AGENT_KEY),
      profiles: PROFILES.map(p => ({ id: p.id, label: p.label, model: p.model })),
    }));
    return;
  }
  if (url.pathname === '/mcp' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as unknown;
      const trace = req.headers['x-scrip-trace'];
      const traceId = Array.isArray(trace) ? trace[0] : trace;
      const messages = Array.isArray(body) ? body : [body];
      const replies = (await Promise.all(messages.map(m => tools.handle(m, traceId)))).filter(r => r !== null);
      if (replies.length === 0) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: (error as Error).message } }));
    }
    return;
  }
  if (url.pathname === '/mcp') { res.writeHead(405); res.end(); return; }
  if (url.pathname === '/track-record') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(trackRecords(store.traceIds().map(id => store.events(id)))));
    return;
  }
  if (url.pathname === '/run' || url.pathname === '/run-agent') {
    if (running) { res.writeHead(409); res.end('A run is already in progress'); return; }
    const mode = url.searchParams.get('mode') === 'sandbox' ? 'sandbox' : 'offline';
    running = true;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send: Send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = url.pathname === '/run-agent'
        ? await runRealAgent(url.searchParams.get('profile') ?? 'careful', mode, url.searchParams.get('web') === '1', url.searchParams.get('request') ?? 'precise', send)
        : await runFlightTraceDemo({
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
