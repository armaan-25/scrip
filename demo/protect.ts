/**
 * Scrip: purchase-bound controls for agent cards. One demo, one flow:
 *
 *   approve -> authorize -> verify -> recover
 *
 * One immutable approved purchase record is used everywhere: the card is
 * bound to its fingerprint, the issuer gate compares merchant orders to
 * that fingerprint, the assessor compares fulfillment to the same record,
 * and the recovery packet carries it. The agent cannot substitute it.
 *
 * Everything on the rail side is SIMULATED and labeled so. No card is
 * issued, no money moves, no merchant is contacted, no dispute is filed.
 *
 * Run: npm run demo:protect
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';

// The live rail reads NATURAL_API_KEY from .env when present.
if (fs.existsSync('.env')) process.loadEnvFile('.env');
import { loadConfig } from '../src/config.js';
import { CardPaymentCapabilityProvider } from '../src/cards/card-payments.js';
import { SimulatedAcceptMerchant, SimulatedIssuer, SimulatedWebMerchant } from '../src/cards/simulated-rail.js';
import type { CardAuthorizationDecision } from '../src/cards/types.js';
import type { AgentManifest } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { SqliteMissionStore } from '../src/missions/mission-store.js';
import { PurchaseMissionService } from '../src/missions/purchase-mission-service.js';
import type {
  BookingEvidence, ContractInput, ExecutionProvider, ExecutionRequest, HotelBooking, MissionReceipt,
} from '../src/missions/types.js';
import { openRecoveryCase, type RecoveryCase } from '../src/protect/recovery-case.js';
import { NaturalSettlementProvider, type LiveSettlement } from '../src/rails/natural-settlement.js';

// ----------------------------------------------------------------- fixture

const consumer = 'armaan';
export const approvedBooking: HotelBooking = {
  quoteId: 'Q-7731', merchant: 'hotel.example', hotelName: 'Boston Harbor Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4.5,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline.',
};
export const driftedBooking: HotelBooking = { ...approvedBooking, startsOn: '2099-09-19', endsOn: '2099-09-21' };
const DESCRIPTOR = 'BOSTON HARBOR HOTEL';

const terms: ContractInput = {
  goal: 'Book a refundable double at the Boston Harbor Hotel, Sept 18-20',
  category: 'travel', currency: 'USD', maximumTotal: 550,
  hardConstraints: [
    { type: 'amount_at_most', amount: 550 },
    { type: 'merchant_in', merchants: ['hotel.example'] },
    { type: 'date_range', startsOn: approvedBooking.startsOn, endsOn: approvedBooking.endsOn },
    { type: 'refundable_until', timestamp: approvedBooking.refundableUntil },
    { type: 'rating_at_least', value: 4, scale: 5 },
    { type: 'text_match', field: 'city', expected: 'Boston' },
  ],
  preferences: [], unresolvedHardConstraints: [],
  fundingSourceId: 'wallet-main', permittedMerchants: ['hotel.example'],
  expiresAt: '2099-09-15T12:00:00-04:00', approvalPolicy: 'confirm_exact_purchase', purchase: approvedBooking,
  successConditions: ['booking_matches_contract', 'payment_captured'],
  recoveryPolicy: {
    allowMerchantCancellation: true, allowMerchantRefundRequest: true, allowReplacement: false,
    allowRebooking: false, disputeRequiresConfirmation: true,
  },
};

const manifest: AgentManifest = {
  model: 'claude-opus-5', modelIsMutableAlias: false,
  instructionsDigest: 'sha256:9c1e', policyDigest: 'sha256:44ab', codeArtifact: 'git:9a05375',
  tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read'] }],
};

// ---------------------------------------------------------------- timeline

export interface TimelineStep {
  scenario: string;
  at: string;
  actor: 'person' | 'scrip' | 'agent' | 'SIMULATED issuer' | 'SIMULATED merchant' | 'SIMULATED provider' | 'LIVE Natural';
  label: string;
  detail?: string;
  outcome?: 'ok' | 'blocked' | 'warn' | 'info';
}

export interface ScenarioResult {
  missionId: string;
  decisions: CardAuthorizationDecision[];
  captureCount: number;
  assessment?: string;
  receipt: Pick<MissionReceipt, 'authorized' | 'captured' | 'refunded' | 'returned' | 'unrecovered' | 'refundPending'> & { status: string };
  recovery?: RecoveryCase;
  finalReceipt?: ScenarioResult['receipt'];
}

export interface ProtectDemoResult {
  rail: 'simulated' | 'natural';
  live?: { balancesBefore: { source: number; merchant: number }; balancesAfter: { source: number; merchant: number }; settlements: LiveSettlement[] };
  approval: { summary: string; hash: string; purchaseDigest: string; agentVersionId: string; mandateId: string };
  correct: ScenarioResult;
  violations: ScenarioResult & { probeReasons: string[][] };
  orderMismatch: ScenarioResult & { forgedReasons: string[]; mismatchReasons: string[] };
  noIntegration: { detector: ScenarioResult; consumer: ScenarioResult };
  timeline: TimelineStep[];
}

// ------------------------------------------------ simulated agent checkout

interface Merchant { label: string; checkout(cardRef: string, booking: HotelBooking, opts?: { forgeSignature?: boolean }): { decision: CardAuthorizationDecision; evidence?: BookingEvidence } }

/**
 * SIMULATED agent runtime. It receives the single-use card and goes to a
 * merchant. `sells` is what the merchant actually sells it, which can drift
 * from what the agent asked for: the agent's proposal already passed
 * preflight, so drift can only originate at checkout.
 */
class SimulatedCheckout implements ExecutionProvider {
  readonly label = 'SIMULATED agent checkout';
  private evidence = new Map<string, BookingEvidence[]>();
  decisions: CardAuthorizationDecision[] = [];
  constructor(
    private merchant: Merchant,
    private options: { sells?: HotelBooking; before?: (cardRef: string) => void; forgeSignatureFirst?: boolean } = {},
  ) {}
  async start(request: ExecutionRequest) {
    this.options.before?.(request.capabilityRef);
    if (this.options.forgeSignatureFirst) {
      const forged = this.merchant.checkout(request.capabilityRef, this.options.sells ?? request.booking, { forgeSignature: true });
      this.decisions.push(forged.decision);
    }
    const result = this.merchant.checkout(request.capabilityRef, this.options.sells ?? request.booking);
    this.decisions.push(result.decision);
    if (result.evidence) this.evidence.set(request.operationKey, [result.evidence]);
    return {
      executionRef: `simexec_${request.operationKey.slice(0, 8)}`,
      narrative: result.decision.approved ? 'Booked it, all good!' : 'Card was declined at checkout.',
    };
  }
  async getEvidence(key: string) { return structuredClone(this.evidence.get(key) ?? []); }
  async stop() {}
}

// --------------------------------------------------------------------- run

export interface ProtectDemoOptions { rail?: 'simulated' | 'natural' }

export async function runProtectDemo(log: (line?: string) => void = console.log, options: ProtectDemoOptions = {}): Promise<ProtectDemoResult> {
  const rail = options.rail ?? (process.env.SCRIP_RAIL === 'natural' ? 'natural' : 'simulated');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-protect-'));
  const store = new SqliteMissionStore(path.join(directory, 'missions.sqlite'));
  const registry = new SqliteAgentRegistry(path.join(directory, 'agents.sqlite'));
  const config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 550;
  config.budgets.research.monthlyLimit = 100000;
  const now = () => new Date();
  const issuer = new SimulatedIssuer(now);
  const simulatedPayments = new CardPaymentCapabilityProvider(issuer, () => [DESCRIPTOR], now);
  const natural = rail === 'natural' ? new NaturalSettlementProvider(simulatedPayments, issuer, `scrip-protect-${Date.now()}`) : undefined;
  const payments = natural ?? simulatedPayments;
  const accept = new SimulatedAcceptMerchant(issuer, { merchantId: 'hotel.example', descriptor: DESCRIPTOR, mcc: '7011', sharedKey: 'sim-shared-key' }, now);
  const web = new SimulatedWebMerchant(issuer, { merchantId: 'hotel.example', descriptor: DESCRIPTOR, mcc: '7011' }, now);
  const timeline: TimelineStep[] = [];
  const step = (scenario: string, actor: TimelineStep['actor'], label: string, detail?: string, outcome: TimelineStep['outcome'] = 'info') => {
    timeline.push({ scenario, at: now().toISOString(), actor, label, detail, outcome });
    const mark = outcome === 'ok' ? chalk.green('  ✓ ') : outcome === 'blocked' ? chalk.red.bold('  ✗ ') : outcome === 'warn' ? chalk.yellow('  ! ') : chalk.dim('  · ');
    log(mark + chalk.dim(`[${actor}] `) + label + (detail ? chalk.dim(`  ${detail}`) : ''));
  };
  const heading = (n: string, title: string) => { log(); log(chalk.bold.inverse(` ${n} `) + ' ' + chalk.bold(title)); };
  const money = (n: number) => `$${n.toFixed(2)}`;

  // Agent identity is registered once; every scenario uses the same version.
  const lineage = registry.registerLineage({ ownerId: consumer, operator: 'acme-labs', displayName: 'Shopper' }, now());
  const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest, registeredBy: consumer }, now());
  const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());

  const services = new Map<string, PurchaseMissionService>();
  /** Approves one mission bound to the fixture and this agent version. */
  async function ratify(scenario: string, execution: ExecutionProvider) {
    const service = new PurchaseMissionService(store, config, 'research', execution, payments, now, registry);
    const mission = await service.create(consumer, structuredClone(terms));
    const rendered = service.renderApproval(consumer, mission.missionId);
    const mandate = registry.createMandate({
      principalId: consumer, lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
      fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-09-15T00:00:00Z',
      outcomeContractDigest: rendered.hash, changePolicy: 'require_approval', approvedBy: consumer, approvedAt: now().toISOString(),
    });
    await service.approve(consumer, mission.missionId, { channel: 'web', contractVersion: rendered.contractVersion, renderedSummaryHash: rendered.hash },
      { agentLineageId: lineage.lineageId, authorizedAgentVersionId: version.versionId, financialMandateId: mandate.mandateId });
    services.set(mission.missionId, service);
    step(scenario, 'person', `approved contract v${rendered.contractVersion}`, `hash ${rendered.hash.slice(0, 12)}…`, 'ok');
    return { service, missionId: mission.missionId, rendered, mandate };
  }
  const snapshot = (r: MissionReceipt): ScenarioResult['receipt'] => ({
    authorized: r.authorized, captured: r.captured, refunded: r.refunded, returned: r.returned,
    unrecovered: r.unrecovered, refundPending: r.refundPending, status: r.mission.status,
  });
  const describeDecision = (scenario: string, d: CardAuthorizationDecision, extra?: string) => {
    if (d.approved) step(scenario, 'SIMULATED issuer', `authorization approved (tier: ${d.tier})`, extra, 'ok');
    else step(scenario, 'SIMULATED issuer', `authorization declined (tier: ${d.tier})`, (extra ? `${extra}: ` : '') + d.reasons.join('; '), 'blocked');
  };
  const captureCount = (missionId: string, service: PurchaseMissionService) =>
    issuer.decisions(service.get(consumer, missionId).operation?.key ?? '').filter(r => r.captured).length;

  try {
    log(chalk.bold('Scrip: purchase-bound controls for agent cards'));
    let balancesBefore = { source: 0, merchant: 0 };
    if (natural) {
      log(chalk.yellow('Rail: LIVE Natural for money facts ($1.00 wallet-to-wallet per capture, inside your own account). Card, issuer gate, and merchants are SIMULATED.'));
      const swept = await natural.sweepBack();
      if (swept.cents) step('approve', 'LIVE Natural', `reset: swept ${money(swept.cents / 100)} back from the simulated-merchant wallet`, swept.transferId, 'info');
      balancesBefore = await natural.balances();
      step('approve', 'LIVE Natural', `balances before: wallet ${money(balancesBefore.source / 100)}, simulated-merchant wallet ${money(balancesBefore.merchant / 100)}`);
    } else {
      log(chalk.dim('All rail-side actors are SIMULATED. No card is issued, no money moves, no merchant is contacted.'));
    }
    const liveNote = (scenario: string, missionId: string, service: PurchaseMissionService) => {
      if (!natural) return;
      const key = service.get(consumer, missionId).operation?.key;
      const live = key ? natural.settlement(key) : undefined;
      if (live) step(scenario, 'LIVE Natural', `money fact: transfer ${live.captureTransferId} ${live.captureStatus}`, `${money(live.liveCents / 100)} live for a ${money(500)} ledger capture; tagged with the purchase fingerprint`, 'ok');
    };

    // ================================================================ APPROVE
    heading('APPROVE', 'one person, one exact purchase, one agent version');
    const first = await ratify('approve', new SimulatedCheckout(accept));
    const shown = first.service.get(consumer, first.missionId).contract;
    const { purchaseDigest } = await import('../src/cards/card-gate.js');
    const digest = purchaseDigest(shown.purchase);
    log(chalk.dim(`    ${shown.purchase.hotelName}, ${shown.purchase.roomType}, ${shown.purchase.startsOn} → ${shown.purchase.endsOn}, ${money(shown.purchase.total)} (cap ${money(shown.maximumTotal)}), refundable to ${shown.purchase.refundableUntil}`));
    log(chalk.dim(`    purchase fingerprint ${digest}`));
    log(chalk.dim(`    agent version ${version.versionId.slice(0, 8)} (${version.attestationLevel})`));
    const approval = { summary: first.rendered.summary, hash: first.rendered.hash, purchaseDigest: digest, agentVersionId: version.versionId, mandateId: first.mandate.mandateId };

    // ============================================================ SCENARIO 1
    heading('1', 'Correct purchase at an integrated merchant');
    const s1 = first;
    const s1exec = (s1.service as unknown as { execution: SimulatedCheckout }).execution;
    step('correct', 'scrip', 'preflight passed; single-use card issued, bound to the fingerprint', undefined, 'ok');
    await s1.service.execute(consumer, s1.missionId, approvedBooking, credential);
    for (const d of s1exec.decisions) describeDecision('correct', d, 'signed order matched the approved purchase');
    step('correct', 'SIMULATED merchant', `captured ${money(500)}; fulfillment confirmed via merchant API`, undefined, 'ok');
    liveNote('correct', s1.missionId, s1.service);
    let r1 = await s1.service.getReceipt(consumer, s1.missionId);
    step('correct', 'scrip', `assessment: ${r1.assessment?.status}`, r1.assessment?.reasons[0], 'ok');
    const correct: ScenarioResult = { missionId: s1.missionId, decisions: s1exec.decisions, captureCount: captureCount(s1.missionId, s1.service), assessment: r1.assessment?.status, receipt: snapshot(r1) };

    // ============================================================ SCENARIO 2
    heading('2', 'Merchant, amount, currency, and time-window violations declined by the issuer');
    const probeReasons: string[][] = [];
    const probes = (cardRef: string) => {
      const base = { cardRef, merchantDescriptor: DESCRIPTOR, mcc: '7011', amount: 500, currency: 'USD' as const, occurredAt: now().toISOString() };
      const attempts: [string, Parameters<SimulatedIssuer['authorize']>[0]][] = [
        ['different merchant, same amount', { ...base, merchantDescriptor: 'SOME OTHER HOTEL' }],
        ['right merchant, $600 (cap $550)', { ...base, amount: 600 }],
        ['right merchant, EUR', { ...base, currency: 'EUR' as unknown as 'USD' }],
        ['right merchant, charged after the window closed', { ...base, occurredAt: '2099-09-16T00:00:00Z' }],
      ];
      for (const [label, request] of attempts) {
        // The window check uses the issuer's clock; simulate "after expiry" by freezing? No: keep the
        // clock honest and drive the fourth probe through a binding whose window has closed.
        const decision = label.includes('window')
          ? (() => { const b = issuer.binding(cardRef)!; const { authorizeCard } = probesGate; return authorizeCard({ ...b }, request, new Date('2099-09-16T00:00:00Z'), 'probe-window'); })()
          : issuer.authorize(request);
        step('violations', 'agent', `attempts: ${label}`);
        describeDecision('violations', decision);
        if (!decision.approved) probeReasons.push(decision.reasons);
      }
    };
    const probesGate = await import('../src/cards/card-gate.js');
    const s2exec = new SimulatedCheckout(accept, { before: probes });
    const s2 = await ratify('violations', s2exec);
    await s2.service.execute(consumer, s2.missionId, approvedBooking, credential);
    for (const d of s2exec.decisions) describeDecision('violations', d, 'then the correct charge');
    const s2key = s2.service.get(consumer, s2.missionId).operation?.key ?? '';
    const s2card = simulatedPayments.cardFor(s2key);
    if (!s2card) throw new Error('scenario 2: no card was issued for the operation');
    const reuse = issuer.authorize({ cardRef: s2card, merchantDescriptor: DESCRIPTOR, mcc: '7011', amount: 500, currency: 'USD', occurredAt: now().toISOString() });
    step('violations', 'agent', 'attempts: the same card a second time');
    describeDecision('violations', reuse);
    if (!reuse.approved) probeReasons.push(reuse.reasons);
    await s2.service.reconcile(consumer, s2.missionId);
    liveNote('violations', s2.missionId, s2.service);
    const r2 = await s2.service.getReceipt(consumer, s2.missionId);
    const violations = { missionId: s2.missionId, decisions: [...s2exec.decisions, reuse], captureCount: captureCount(s2.missionId, s2.service), assessment: r2.assessment?.status, receipt: snapshot(r2), probeReasons };

    // ============================================================ SCENARIO 3
    heading('3', 'Same merchant, same price, different dates: caught before capture (integrated merchant)');
    const s3exec = new SimulatedCheckout(accept, { sells: driftedBooking, forgeSignatureFirst: true });
    const s3 = await ratify('order-mismatch', s3exec);
    step('order-mismatch', 'scrip', 'preflight passed on the agent\'s candidate (correct dates); card issued', undefined, 'ok');
    step('order-mismatch', 'SIMULATED merchant', 'checkout drifts: merchant is about to sell Sept 19-21 at the same $500');
    await s3.service.execute(consumer, s3.missionId, approvedBooking, credential);
    const [forged, mismatch] = s3exec.decisions;
    describeDecision('order-mismatch', forged, 'first attempt: order with a forged signature');
    describeDecision('order-mismatch', mismatch, 'second attempt: properly signed order for the wrong dates');
    step('order-mismatch', 'scrip', 'nothing captured; mission cancelled by the operator', undefined, 'ok');
    await s3.service.cancel(consumer, s3.missionId);
    const r3 = await s3.service.getReceipt(consumer, s3.missionId);
    const orderMismatch = {
      missionId: s3.missionId, decisions: s3exec.decisions, captureCount: captureCount(s3.missionId, s3.service),
      assessment: r3.assessment?.status, receipt: snapshot(r3),
      forgedReasons: forged.approved ? [] : forged.reasons, mismatchReasons: mismatch.approved ? [] : mismatch.reasons,
    };

    // ============================================================ SCENARIO 4
    heading('4', 'Same drift, merchant NOT integrated: exact-purchase enforcement unavailable; caught afterward; recovery');
    async function noIntegration(openedBy: 'consumer' | 'detector'): Promise<ScenarioResult> {
      const tag = `no-integration/${openedBy}`;
      log(chalk.bold(openedBy === 'detector' ? '  4a  case opened by Scrip\'s detector' : '  4b  same run, case opened by the person'));
      const exec = new SimulatedCheckout(web, { sells: driftedBooking });
      const s = await ratify(tag, exec);
      step(tag, 'scrip', 'card issued; this merchant sends no order data', 'exact-purchase enforcement: UNAVAILABLE at authorization', 'warn');
      step(tag, 'SIMULATED merchant', 'checkout drifts: sells Sept 19-21 at $500');
      await s.service.execute(consumer, s.missionId, approvedBooking, credential);
      describeDecision(tag, exec.decisions[0], 'issuer sees only merchant, amount, currency, time: all pass');
      step(tag, 'SIMULATED merchant', `captured ${money(500)}`, undefined, 'warn');
      liveNote(tag, s.missionId, s.service);
      let r = await s.service.getReceipt(consumer, s.missionId);
      step(tag, 'SIMULATED merchant', 'confirmation email arrives: Sept 19-21', '(source: email, parsed)', 'warn');
      step(tag, 'scrip', `assessment: ${r.assessment?.status}`, r.assessment?.reasons[0], 'blocked');
      step(tag, 'scrip', `receipt: captured ${money(r.captured)}, unrecovered ${money(r.unrecovered)}`);
      const before = snapshot(r);
      const recovery = await openRecoveryCase({ service: s.service, store, now }, consumer, s.missionId, openedBy);
      step(tag, openedBy === 'consumer' ? 'person' : 'scrip', `recovery case opened by ${openedBy}`,
        `packet ${recovery.packet.packetDigest.slice(0, 12)}…; mismatched fields: ${recovery.packet.mismatches.map(m => m.fields.join(',')).join(' | ')}`, 'info');
      r = await s.service.getReceipt(consumer, s.missionId);
      step(tag, 'scrip', `refund requested from merchant: ${recovery.refundRequested}`, `refund pending: ${r.refundPending}; unrecovered still ${money(r.unrecovered)}`, 'warn');
      const authRef = issuer.decisions(s.service.get(consumer, s.missionId).operation!.key).find(d => d.captured)!.authRef;
      issuer.refund(authRef, 500);
      if (natural) {
        const live = await natural.postRefund(s.service.get(consumer, s.missionId).operation!.key);
        step(tag, 'LIVE Natural', `merchant returned funds: transfer ${live.refundTransferId} ${live.refundStatus}`, `${money(live.liveCents / 100)} live back to the wallet`, 'ok');
      } else {
        step(tag, 'SIMULATED provider', 'evidence: returned funds posted', undefined, 'ok');
      }
      await s.service.reconcile(consumer, s.missionId);
      r = await s.service.getReceipt(consumer, s.missionId);
      step(tag, 'scrip', `receipt: refunded ${money(r.refunded)}, unrecovered ${money(r.unrecovered)}, mission ${r.mission.status}`, undefined, 'ok');
      return { missionId: s.missionId, decisions: exec.decisions, captureCount: captureCount(s.missionId, s.service), assessment: before.status === 'recovery_required' ? 'failure' : r.assessment?.status, receipt: before, recovery, finalReceipt: snapshot(r) };
    }
    const detector = await noIntegration('detector');
    const consumerOpened = await noIntegration('consumer');

    log();
    log(chalk.bold.inverse(' SUMMARY '));
    log('  Right merchant, right amount, wrong purchase.');
    log('  Integrated merchant   → blocked before capture (order tier).');
    log('  Not integrated        → passes authorization; caught by fulfillment evidence; recovery case; refund pending until funds post.');
    log();

    let live: ProtectDemoResult['live'];
    if (natural) {
      const balancesAfter = await natural.balances();
      const settlements = [correct, violations, detector, consumerOpened]
        .map(s => natural.settlement(services.get(s.missionId)!.get(consumer, s.missionId).operation!.key)).filter((x): x is LiveSettlement => !!x);
      step('summary', 'LIVE Natural', `balances after: wallet ${money(balancesAfter.source / 100)}, simulated-merchant wallet ${money(balancesAfter.merchant / 100)}`, `${settlements.length} live captures, ${settlements.filter(x => x.refundTransferId).length} live refunds`);
      live = { balancesBefore, balancesAfter, settlements };
    }
    return { rail, live, approval, correct, violations, orderMismatch, noIntegration: { detector, consumer: consumerOpened }, timeline };
  } finally {
    store.close(); registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runProtectDemo().catch(error => { console.error(error); process.exit(1); });
}
