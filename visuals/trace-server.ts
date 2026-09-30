/**
 * Live page for Scrip. Two kinds of runs, both streamed to the browser as
 * they happen (server-sent events):
 *   /run        the three scripted agents (repeatable demo)
 *   /run-agent  a real Claude agent that searches (Scrip's demo catalog, or the
 *               live web), states its understanding, requests a purchase and
 *               pays through Scrip's tools on /mcp
 * Every step also re-runs the monitors on that trace and streams its alerts.
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
import { type FlightSource, findProfile, instructionsFor, manifestFor, PROFILES, scripToolsFor, TASK_MODELS } from '../src/agent/profiles.js';
import type { PurchaseTask } from '../src/purchase/purchase.js';
import { runClaudeAgent } from '../src/agent/run-claude-agent.js';
import { type RunContext, ScripToolServer } from '../src/agent/tool-server.js';
import { loadConfig } from '../src/config.js';
import { confirmedRequirements, demoRequest } from '../src/flights/fixtures.js';
import type { FlightRequirements } from '../src/flights/types.js';
import { TaskAuthorizationManager } from '../src/lease.js';
import type { AuthenticatedAgent } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { setupMerchantRail } from '../src/rails/merchant-rail.js';
import { type Rail, setupRail } from '../src/rails/rail-setup.js';
import type { ScripMode } from '../src/agent/checkout.js';
import { overview, runActivity } from '../src/trace/activity.js';
import { renderTimeline } from '../src/trace/timeline.js';
import type { RecordedEvent } from '../src/trace/events.js';
import { monitorAlerts } from '../src/trace/monitors.js';
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

function agentFor(profileId: string, source: FlightSource) {
  const key = `${profileId}:${source}`;
  const cached = agents.get(key);
  if (cached) return cached;
  const profile = source === 'task' ? TASK_MODELS.find(m => m.id === profileId) : findProfile(profileId);
  if (!profile) throw new Error(`Unknown agent profile ${profileId}`);
  const lineage = registry.registerLineage({ ownerId: 'armaan', operator: 'scrip-demo', displayName: profile.label }, now());
  const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest: manifestFor(profile, source), registeredBy: 'armaan' }, now());
  const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());
  const entry = { lineageId: lineage.lineageId, versionId: version.versionId, auth: registry.authenticate(credential.credentialId, credential.secret, now()) };
  agents.set(key, entry);
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
type Feedback = 'explain' | 'ask_customer';

/** Streams one step, then the monitors' alerts for that scenario's trace so far. */
function stepSender(send: Send) {
  const seen = new Map<string, RecordedEvent[]>();
  return (scenario: string, e: RecordedEvent) => {
    const events = [...(seen.get(scenario) ?? []), e];
    seen.set(scenario, events);
    send('step', { scenario, type: e.type, at: e.at, line: renderTimeline([e])[0], data: e.data });
    send('alerts', { scenario, alerts: monitorAlerts(events) });
    send('activity', { scenario, activity: runActivity(events) });
  };
}
/** Search results and page summaries are kept long enough for the monitors to check claims against. */
const RESEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'search_flights']);

/**
 * What the person tells the agent (precise or vague wording) and what they
 * confirmed, per flight source. The confirmed requirements are the same for
 * both wordings. Real-web runs use a budget real nonstop fares can meet and
 * drop "refundable", which real fares under the budget rarely are.
 */
const vague = 'Get me the cheapest flight from NYC to SF, out Friday Oct 16, back Sunday Oct 18.';
const SOURCES: Record<Exclude<FlightSource, 'task'>, { requirements: FlightRequirements; requests: Record<string, string> }> = {
  catalog: { requirements: confirmedRequirements, requests: { precise: demoRequest, vague } },
  web: {
    requirements: { ...confirmedRequirements, refundableOnly: false, maxTotalCents: 70000 },
    requests: { precise: 'Book a round trip from JFK to SFO, leaving Friday Oct 16 and returning Sunday Oct 18, 2026. Nonstop only, $700 total max.', vague },
  },
};

/** Any purchase: the person's words verbatim, their budget and must-haves, a real agent on the web, and the merchant wallet. */
async function runTaskAgent(modelId: string, mode: 'offline' | 'sandbox', task: PurchaseTask, refusalFeedback: Feedback, scripMode: ScripMode, send: Send) {
  const profile = TASK_MODELS.find(m => m.id === modelId) ?? TASK_MODELS[0];
  if (!profile) throw new Error('No task model');
  const agent = agentFor(profile.id, 'task');
  const scenario = `real:task-${profile.id}`;
  const merchant = setupMerchantRail(mode, `scrip-task-${Date.now()}`, 'Merchant (simulated)');
  send('log', { line: mode === 'sandbox' ? 'Live on Natural\'s sandbox. Accepted checkouts are paid as a transfer to the "Merchant (simulated)" wallet.' : 'Offline: simulated Natural.' });
  send('log', { line: `Real agent: ${profile.label}, working on the live web. Scrip is in ${scripMode} mode; must-haves are checked by a separate Claude Haiku call, recorded in the trace. No real store is paid; a Natural wallet stands in for it.` });
  const step = stepSender(send);
  service.onEvent = e => step(scenario, e);
  const traceId = service.start('armaan', task.words);
  try {
    service.confirmTask(traceId, { budgetCents: task.budgetCents, musts: task.musts });
    contexts.set(traceId, { traceId, agent: agent.auth, mandateId: '', merchant, scripMode, flights: 'task', task, refusalFeedback });
    const prompt = `Customer request: "${task.words}"\nBudget: $${(task.budgetCents / 100).toFixed(2)} total.${task.musts.length ? `\nMust-haves:\n${task.musts.map(m => `- ${m}`).join('\n')}` : ''}`;
    service.recordAgent(traceId, { type: 'agent_run_started', data: { agentVersionId: agent.versionId, profile: scenario.slice(5), model: profile.model, prompt, refusalFeedback } });
    const toolNames = new Map<string, string>();
    let final = { ok: false, turns: null as number | null, costUsd: null as number | null, summary: '' };
    const run = await runClaudeAgent({
      prompt, systemPrompt: instructionsFor(profile, 'task'), model: profile.model,
      mcpUrl: `http://localhost:${PORT}/mcp`, traceId, allowWeb: true, scripTools: scripToolsFor('task'), maxTurns: 40, timeoutMs: 480_000,
      onActivity: a => {
        if (a.kind === 'tool_call' && !a.internal) { toolNames.set(a.toolUseId, a.tool); service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: a.toolUseId, tool: a.tool, input: a.input } }); }
        if (a.kind === 'tool_result' && toolNames.has(a.toolUseId)) service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: a.toolUseId, tool: toolNames.get(a.toolUseId) ?? '?', output: a.output.slice(0, RESEARCH_TOOLS.has(toolNames.get(a.toolUseId) ?? '') ? 20_000 : 2000), isError: a.isError } });
        if (a.kind === 'message') service.recordAgent(traceId, { type: 'agent_message', data: { text: a.text.slice(0, 2000) } });
        if (a.kind === 'final') final = { ok: a.ok, turns: a.turns, costUsd: a.costUsd, summary: a.text.slice(0, 2000) };
      },
    });
    if (run.exitCode !== 0 && !final.ok) send('log', { line: `Agent exited with code ${run.exitCode}. ${run.stderr.split('\n').slice(-3).join(' ')}` });
    service.recordAgent(traceId, { type: 'agent_run_finished', data: final });
  } finally {
    contexts.delete(traceId);
    service.onEvent = undefined;
  }
  const attempts = runActivity(service.events(traceId)).attempts;
  return { scenarios: [{ name: scenario, traceId, outcome: attempts.at(-1)?.status ?? 'no_checkout' }] };
}

/** Reads the any-purchase task from the query: words, budget in dollars, must-haves one per line. */
function taskFrom(url: URL): PurchaseTask {
  const words = (url.searchParams.get('task') ?? '').trim().slice(0, 1000);
  const budgetCents = Math.round(Number(url.searchParams.get('budget')) * 100);
  if (!words) throw new Error('Type what the agent should buy.');
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) throw new Error('Set a budget above $0.');
  const musts = (url.searchParams.get('musts') ?? '').split('\n').map(m => m.trim()).filter(Boolean).slice(0, 12);
  return { words, budgetCents, musts };
}

async function runRealAgent(profileId: string, mode: 'offline' | 'sandbox', flights: Exclude<FlightSource, 'task'>, requestKind: string, refusalFeedback: Feedback, scripMode: ScripMode, send: Send) {
  const source = SOURCES[flights];
  const words = source.requests[requestKind] ?? source.requests.precise;
  const allowWeb = flights === 'web';
  const profile = findProfile(profileId);
  if (!profile) throw new Error(`Unknown agent profile ${profileId}`);
  const agent = agentFor(profileId, flights);
  const scenario = `real:${profile.id}${allowWeb ? '-web' : ''}`;
  // Web runs pay a Natural wallet acting as the merchant; catalog runs use the approval-hold rail.
  const runId = `scrip-agent-${Date.now()}`;
  const rail: Rail | undefined = allowWeb ? undefined : await setupRail(mode, runId);
  const merchant = allowWeb ? setupMerchantRail(mode, runId) : undefined;
  send('log', { line: mode === 'sandbox'
    ? (rail ? `Live on Natural's sandbox. Agent ${rail.naturalAgentId} limited to 1 cent so every payment is held for Scrip.` : 'Live on Natural\'s sandbox. Accepted checkouts are paid as a transfer to the "Example Air (merchant)" wallet.')
    : 'Offline: simulated Natural.' });
  send('log', { line: allowWeb
    ? `Real agent: Claude (${profile.model}) as "${profile.label}", researching real flights on the live web. Scrip is in ${scripMode} mode. No airline is paid; a Natural wallet stands in for it.`
    : `Real agent: Claude (${profile.model}) as "${profile.label}". The flight catalog and merchant are simulated.` });
  const step = stepSender(send);
  service.onEvent = e => step(scenario, e);
  const traceId = service.start('armaan', words);
  try {
    const requirementsDigest = service.confirm(traceId, source.requirements);
    const mandate = registry.createMandate({
      principalId: 'armaan', lineageId: agent.lineageId, authorizedVersionIds: [agent.versionId],
      fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
      outcomeContractDigest: requirementsDigest, changePolicy: 'require_approval', approvedBy: 'armaan', approvedAt: now().toISOString(),
    });
    contexts.set(traceId, { traceId, agent: agent.auth, mandateId: mandate.mandateId, rail, merchant, scripMode, flights, webOffers: new Map(), refusalFeedback });
    const prompt = `Customer request: "${words}"`;
    service.recordAgent(traceId, { type: 'agent_run_started', data: { agentVersionId: agent.versionId, profile: scenario.slice(5), model: profile.model, prompt, refusalFeedback } });

    const toolNames = new Map<string, string>();
    let final = { ok: false, turns: null as number | null, costUsd: null as number | null, summary: '' };
    const run = await runClaudeAgent({
      prompt, systemPrompt: instructionsFor(profile, flights), model: profile.model,
      mcpUrl: `http://localhost:${PORT}/mcp`, traceId, allowWeb, scripTools: scripToolsFor(flights),
      maxTurns: allowWeb ? 40 : 24, timeoutMs: allowWeb ? 480_000 : 240_000,
      onActivity: a => {
        if (a.kind === 'tool_call' && !a.internal) { toolNames.set(a.toolUseId, a.tool); service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: a.toolUseId, tool: a.tool, input: a.input } }); }
        if (a.kind === 'tool_result' && toolNames.has(a.toolUseId)) service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: a.toolUseId, tool: toolNames.get(a.toolUseId) ?? '?', output: a.output.slice(0, RESEARCH_TOOLS.has(toolNames.get(a.toolUseId) ?? '') ? 20_000 : 2000), isError: a.isError } });
        if (a.kind === 'message') service.recordAgent(traceId, { type: 'agent_message', data: { text: a.text.slice(0, 2000) } });
        if (a.kind === 'final') final = { ok: a.ok, turns: a.turns, costUsd: a.costUsd, summary: a.text.slice(0, 2000) };
      },
    });
    if (run.exitCode !== 0 && !final.ok) send('log', { line: `Agent exited with code ${run.exitCode}. ${run.stderr.split('\n').slice(-3).join(' ')}` });
    service.recordAgent(traceId, { type: 'agent_run_finished', data: final });
  } finally {
    contexts.delete(traceId);
    service.onEvent = undefined;
    try { await rail?.restore(); } catch (error) { send('log', { line: `WARNING: could not restore the sandbox agent's limit: ${(error as Error).message}` }); }
  }
  const events = service.events(traceId);
  const attempts = runActivity(events).attempts;
  const outcome = attempts.length ? (attempts.at(-1)?.status ?? 'undecided')
    : events.some(e => e.type === 'payment_settled' && e.data.status === 'COMPLETED') ? 'paid'
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
      defaultMode, sources: SOURCES, sandboxAvailable: Boolean(process.env.NATURAL_SANDBOX_API_KEY && process.env.NATURAL_SANDBOX_AGENT_KEY),
      profiles: PROFILES.map(p => ({ id: p.id, label: p.label, model: p.model })),
      taskModels: TASK_MODELS.map(p => ({ id: p.id, label: p.label })),
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
  if (url.pathname === '/overview') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(overview(store.traceIds().map(id => store.events(id)))));
    return;
  }
  if (url.pathname === '/trace') {
    const events = store.events(url.searchParams.get('id') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ activity: runActivity(events), alerts: monitorAlerts(events) }));
    return;
  }
  if (url.pathname === '/review' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as { attemptId?: unknown; approve?: unknown };
      const result = await tools.review(String(body.attemptId ?? ''), body.approve === true);
      res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: (error as Error).message }));
    }
    return;
  }
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
      const flightsParam = url.searchParams.get('flights');
      const feedback: Feedback = url.searchParams.get('feedback') === 'ask_customer' ? 'ask_customer' : 'explain';
      const scripMode: ScripMode = url.searchParams.get('scrip') === 'observer' ? 'observer' : 'blocker';
      const result = url.pathname === '/run-agent' && flightsParam === 'task'
        ? await runTaskAgent(url.searchParams.get('model') ?? 'sonnet', mode, taskFrom(url), feedback, scripMode, send)
        : url.pathname === '/run-agent'
        ? await runRealAgent(url.searchParams.get('profile') ?? 'careful', mode, url.searchParams.get('flights') === 'web' ? 'web' : 'catalog', url.searchParams.get('request') ?? 'precise', url.searchParams.get('feedback') === 'ask_customer' ? 'ask_customer' : 'explain', url.searchParams.get('scrip') === 'observer' ? 'observer' : 'blocker', send)
        : await runFlightTraceDemo({
          mode,
          log: line => { if (line && !line.startsWith('  ') && !line.startsWith('──')) send('log', { line }); },
          onEvent: stepSender(send),
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
