/**
 * Three agents, one request. Shows (1) what each agent understood the goal to
 * be vs. what the person confirmed, and (2) Natural payments held and released
 * only when the paid-for order's fingerprint matches the approved purchase.
 *
 * Offline by default (in-memory Natural). Live: SCRIP_RAIL=sandbox with
 * NATURAL_SANDBOX_API_KEY and NATURAL_SANDBOX_AGENT_KEY. Fake money only.
 *
 * Limits stated in output: the paid-for fingerprint comes from a simulated
 * seller quote; agents are scripted; requirements arrive already structured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { confirmedRequirements, demoRequest, layoverOffer, nonstopOffer } from '../src/flights/fixtures.js';
import { paymentDescription } from '../src/flights/rules.js';
import type { FlightOffer, FlightRequirements } from '../src/flights/types.js';
import { TaskAuthorizationManager } from '../src/lease.js';
import type { AgentManifest } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { FakeNatural } from '../src/rails/fake-natural.js';
import { NaturalHoldConnector } from '../src/rails/natural-hold-connector.js';
import type { AgentPayer, NaturalPort } from '../src/rails/natural-port.js';
import { SdkAgentPayer, SdkNaturalPort } from '../src/rails/natural-sdk-port.js';
import { settlePayment } from '../src/rails/settle.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
import type { RecordedEvent } from '../src/trace/events.js';
import { renderTimeline } from '../src/trace/timeline.js';
import { SqliteTraceStore } from '../src/trace/trace-store.js';
import { FlightTraceService } from '../src/trace/trace-service.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

interface ScriptedAgent {
  name: string;
  interpret(confirmed: FlightRequirements): FlightRequirements;
  choose(): FlightOffer;
  payFor(approved: FlightOffer): FlightOffer;
}

const AGENTS: ScriptedAgent[] = [
  { name: 'faithful', interpret: r => ({ ...r }), choose: () => nonstopOffer, payFor: o => o },
  { name: 'misreads', interpret: r => ({ ...r, directOnly: false, refundableOnly: false }), choose: () => layoverOffer, payFor: o => o },
  { name: 'switches', interpret: r => ({ ...r }), choose: () => nonstopOffer, payFor: () => layoverOffer },
];

const manifest: AgentManifest = {
  model: 'example-model-1', modelIsMutableAlias: false, instructionsDigest: 'sha256:9c1e',
  policyDigest: 'sha256:44ab', codeArtifact: 'git:flight-demo',
  tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read'] }],
};

export type ScenarioOutcome = 'paid' | 'blocked_before_payment' | 'denied_at_payment' | 'undecided';
export interface FlightDemoResult {
  scenarios: { name: string; traceId: string; outcome: ScenarioOutcome; finalStatus?: string }[];
}

export interface FlightDemoOptions {
  mode?: 'offline' | 'sandbox';
  log?: (line?: string) => void;
  /** Told about every recorded step as it happens, with the scenario it belongs to (drives the live page). */
  onEvent?: (scenario: string, event: RecordedEvent) => void;
}

export async function runFlightTraceDemo(opts: FlightDemoOptions = {}): Promise<FlightDemoResult> {
  const mode = opts.mode ?? (process.env.SCRIP_RAIL === 'sandbox' ? 'sandbox' : 'offline');
  const log = opts.log ?? console.log;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-flight-demo-'));
  const now = () => new Date();
  const registry = new SqliteAgentRegistry(path.join(dir, 'agents.sqlite'));
  const store = new SqliteTraceStore(path.join(dir, 'trace.sqlite'));
  const config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 1000;
  config.budgets.research.monthlyLimit = 100000;
  const ledger = new TaskAuthorizationManager(config, { getReportedSpend: async () => 0, reportTaskUsage: async () => {} });
  const service = new FlightTraceService({ store, registry, ledger, budget: 'research', now });
  let currentScenario = '';
  if (opts.onEvent) { const emit = opts.onEvent; service.onEvent = e => emit(currentScenario, e); }

  let restore: () => Promise<void> = async () => {};
  const restoreSafely = async () => {
    try { await restore(); } catch (error) { log(`WARNING: could not restore the sandbox agent's limits: ${(error as Error).message}`); }
    restore = async () => {};
  };
  const onInterrupt = () => { void restoreSafely().finally(() => process.exit(130)); };
  const result: FlightDemoResult = { scenarios: [] };

  try {
    let owner: NaturalPort;
    let payer: AgentPayer;
    let naturalAgentId: string;
    let recipient: string;

    if (mode === 'sandbox') {
      const ownerKey = process.env.NATURAL_SANDBOX_API_KEY ?? '';
      const agentKey = process.env.NATURAL_SANDBOX_AGENT_KEY ?? '';
      if (!ownerKey.startsWith('sk_ntl_sandbox_') || !agentKey.startsWith('ak_ntl_sandbox_')) throw new Error('Sandbox run needs NATURAL_SANDBOX_API_KEY and NATURAL_SANDBOX_AGENT_KEY (sandbox keys only)');
      const baseUrl = 'https://api.sandbox.natural.com';
      const run = `scrip-flight-${Date.now()}`;
      const sdkOwner = new SdkNaturalPort({ token: ownerKey, baseUrl, instanceId: run });
      const agents = await sdkOwner.listAgentIds();
      const only = agents.length === 1 ? agents[0] : undefined;
      if (!only) throw new Error(`Expected exactly one sandbox agent, found ${agents.length}`);
      const agentId = only.id;
      naturalAgentId = agentId;
      await sdkOwner.fundWallet(100000);
      restore = () => sdkOwner.setAgentLimits(agentId, only.limits ?? null);
      process.once('SIGINT', onInterrupt);
      await sdkOwner.setAgentLimits(agentId, { perTransaction: 1 });
      owner = sdkOwner;
      payer = new SdkAgentPayer({ token: agentKey, baseUrl, instanceId: run });
      recipient = 'payment-recipient@sandbox.natural.test';
      log(`Rail: LIVE Natural sandbox (fake money). Agent ${naturalAgentId} limited to 1 cent so every payment is held.`);
    } else {
      const fake = new FakeNatural();
      fake.limitCents = 1;
      owner = fake;
      naturalAgentId = 'agt_offline';
      payer = fake.agent(naturalAgentId);
      recipient = 'seller';
      log('Rail: offline (in-memory Natural). Set SCRIP_RAIL=sandbox for a live sandbox run.');
    }
    log('Limits: the paid-for fingerprint comes from a simulated seller quote and the connector does not yet check who is paid; agents are scripted; requirements arrive structured.');

    const connector = new NaturalHoldConnector(owner, service);
    const lineage = registry.registerLineage({ ownerId: 'armaan', operator: 'acme-labs', displayName: 'Flight agent' }, now());
    const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest, registeredBy: 'armaan' }, now());
    const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());
    const agentAuth = registry.authenticate(credential.credentialId, credential.secret, now());

    for (const scripted of AGENTS) {
      log();
      log(`── Agent: ${scripted.name} ──`);
      currentScenario = scripted.name;
      const traceId = service.start('armaan', demoRequest);
      const requirementsDigest = service.confirm(traceId, confirmedRequirements);
      const mandate = registry.createMandate({
        principalId: 'armaan', lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
        fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
        outcomeContractDigest: requirementsDigest, changePolicy: 'require_approval', approvedBy: 'armaan', approvedAt: now().toISOString(),
      });
      service.recordInterpretation(traceId, agentAuth, scripted.interpret(confirmedRequirements));
      const chosen = scripted.choose();
      const decision = await service.proposePurchase(traceId, agentAuth, mandate.mandateId, chosen, naturalAgentId);

      if (decision.approved) {
        const paidFor = scripted.payFor(chosen);
        const fingerprintTag = orderFingerprint(paidFor); // simulated seller quote for what is actually being bought
        const payment = await payer.pay({
          amountCents: paidFor.totalCents, recipient, description: paymentDescription(paidFor), instanceId: traceId,
          tags: { scrip_trace_id: traceId, scrip_order_fp: fingerprintTag },
        });
        service.recordPaymentSubmitted(traceId, { paymentId: payment.paymentId, instanceId: traceId, fingerprintTag, amountCents: paidFor.totalCents });
        const settled = await settlePayment(service, connector, owner, traceId, payment.paymentId, log);
        result.scenarios.push({ name: scripted.name, traceId, ...settled });
      } else {
        result.scenarios.push({ name: scripted.name, traceId, outcome: 'blocked_before_payment' });
      }
      for (const line of renderTimeline(service.events(traceId))) log(`  ${line}`);
      const last = result.scenarios.at(-1);
      if (last?.outcome === 'undecided') log('  NOT SETTLED: the connector had not decided this hold when the demo moved on.');
    }
  } finally {
    await restoreSafely();
    process.removeListener('SIGINT', onInterrupt);
    store.close();
    registry.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runFlightTraceDemo().catch(error => { console.error(error); process.exit(1); });
}
