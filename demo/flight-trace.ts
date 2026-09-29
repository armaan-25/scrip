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
import type { FlightOffer, FlightRequirements } from '../src/flights/types.js';
import { TaskAuthorizationManager } from '../src/lease.js';
import type { AgentManifest } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { FakeNatural } from '../src/rails/fake-natural.js';
import { NaturalHoldConnector } from '../src/rails/natural-hold-connector.js';
import { type AgentPayer, type NaturalPort, TERMINAL_STATUSES } from '../src/rails/natural-port.js';
import { SdkAgentPayer, SdkNaturalPort } from '../src/rails/natural-sdk-port.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
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

export interface FlightDemoResult {
  scenarios: { name: string; traceId: string; outcome: 'paid' | 'blocked_before_payment' | 'denied_at_payment'; finalStatus?: string }[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForTerminal(owner: NaturalPort, paymentId: string): Promise<string> {
  let status = 'unknown';
  for (let i = 0; i < 20; i++) {
    status = await owner.getPaymentStatus(paymentId);
    if (TERMINAL_STATUSES.has(status)) return status;
    await sleep(500);
  }
  return status;
}

export async function runFlightTraceDemo(opts: { mode?: 'offline' | 'sandbox'; log?: (line?: string) => void } = {}): Promise<FlightDemoResult> {
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

  let owner: NaturalPort;
  let payer: AgentPayer;
  let naturalAgentId: string;
  let recipient: string;
  let restore: () => Promise<void> = async () => {};

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
    naturalAgentId = only.id;
    await sdkOwner.fundWallet(100000);
    await sdkOwner.setAgentLimits(naturalAgentId, { perTransaction: 1 });
    restore = () => sdkOwner.setAgentLimits(naturalAgentId, only.limits ?? null);
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
  log('Limits: the paid-for fingerprint comes from a simulated seller quote; agents are scripted; requirements arrive structured.');

  const connector = new NaturalHoldConnector(owner, service);
  const lineage = registry.registerLineage({ ownerId: 'armaan', operator: 'acme-labs', displayName: 'Flight agent' }, now());
  const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest, registeredBy: 'armaan' }, now());
  const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());
  const agentAuth = registry.authenticate(credential.credentialId, credential.secret, now());

  const result: FlightDemoResult = { scenarios: [] };
  try {
    for (const scripted of AGENTS) {
      log();
      log(`── Agent: ${scripted.name} ──`);
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

      if (!decision.approved) {
        result.scenarios.push({ name: scripted.name, traceId, outcome: 'blocked_before_payment' });
      } else {
        const paidFor = scripted.payFor(chosen);
        const fingerprintTag = orderFingerprint(paidFor); // simulated seller quote for what is actually being bought
        const payment = await payer.pay({
          amountCents: paidFor.totalCents, recipient, description: `Flight ${paidFor.offerId}`, instanceId: traceId,
          tags: { scrip_trace_id: traceId, scrip_order_fp: fingerprintTag },
        });
        service.recordPaymentSubmitted(traceId, { paymentId: payment.paymentId, instanceId: traceId, fingerprintTag, amountCents: paidFor.totalCents });
        // A new hold can take a moment to appear in Natural's list; keep polling until the connector has decided it.
        const decisionFor = () => service.events(traceId).find(e => e.type === 'hold_decided' && e.data.paymentId === payment.paymentId);
        for (let i = 0; i < 20 && !decisionFor(); i++) { await connector.pollOnce(); if (!decisionFor()) await sleep(500); }
        const decided = decisionFor();
        const denied = decided?.type === 'hold_decided' && decided.data.decision === 'denied';
        const observed = await waitForTerminal(owner, payment.paymentId);
        // The sandbox can mark the hold denied before the payment record catches up; say so rather than print a stale status.
        const finalStatus = denied && !TERMINAL_STATUSES.has(observed) ? `APPROVAL_DENIED (hold denied on Natural; payment record still shows ${observed})`
          : !decided ? `${observed} (connector has not decided this hold yet)` : observed;
        service.recordSettlement(traceId, { paymentId: payment.paymentId, status: finalStatus });
        result.scenarios.push({ name: scripted.name, traceId, outcome: finalStatus === 'COMPLETED' ? 'paid' : 'denied_at_payment', finalStatus: denied ? 'APPROVAL_DENIED' : observed });
      }
      for (const line of renderTimeline(service.events(traceId))) log(`  ${line}`);
    }
  } finally {
    await restore();
    store.close();
    registry.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runFlightTraceDemo().catch(error => { console.error(error); process.exit(1); });
}
