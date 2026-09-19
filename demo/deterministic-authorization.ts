/**
 * Deterministic authorization, end to end, against fake providers.
 *
 *   PROPOSE  (nondeterministic) a model drafts a purchase and extracts typed
 *            constraints; anything it cannot type lands in
 *            unresolvedHardConstraints and blocks ratification.
 *   RATIFY   the consumer approves one exact purchase; approval binds
 *            sha256(canonical(contract)) and an explicit agent version.
 *   ENFORCE  (deterministic) preflight() is a pure function over the
 *            approved record and the candidate. It runs before any payment
 *            capability is issued. No model runs in this phase.
 *
 * The screen that matters is 3a: a legitimately authenticated agent, at a
 * permitted merchant, under the amount cap, proposing the wrong dates - and
 * the payment provider is never called. An amount limit would have let it
 * through. This is the argument the paper makes, in one run.
 *
 * Run: npm run demo:deterministic
 * Nothing here touches a network. Both SQLite files live in a temp directory
 * that is deleted on exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../src/config.js';
import { AgentAuthenticationError, type AgentManifest } from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { SqliteMissionStore } from '../src/missions/mission-store.js';
import { PurchaseMissionService } from '../src/missions/purchase-mission-service.js';
import type {
  BookingEvidence, ContractInput, ExecutionProvider, HotelBooking, PaymentCapabilityProvider, PaymentFact,
} from '../src/missions/types.js';

// --- fake providers ---------------------------------------------------------

/**
 * Stands in for a payment rail and a merchant. `mode` decides what the
 * merchant reports after money moves: 'delivered' confirms the booking,
 * 'not_delivered' reports the booking failed even though payment captured.
 * The second mode is the toothpaste case from the paper.
 */
class FakeProviders {
  mode: 'delivered' | 'not_delivered' = 'delivered';
  issueCalls = 0;
  startCalls = 0;
  private facts = new Map<string, PaymentFact[]>();
  private evidence = new Map<string, BookingEvidence[]>();

  execution: ExecutionProvider = {
    start: async request => {
      this.startCalls++;
      const key = request.operationKey;
      this.facts.set(key, [{
        externalId: `captured:${key}`, operationKey: key, transactionRef: `tx:${key}`,
        kind: 'captured', amount: request.booking.total, currency: 'USD', merchant: request.booking.merchant,
      }]);
      this.evidence.set(key, [{
        source: 'merchant', externalId: `booking:${key}`, operationKey: key, bookingRef: `RES-${key.slice(0, 6)}`,
        status: this.mode === 'delivered' ? 'confirmed' : 'failed', booking: structuredClone(request.booking),
        type: 'hotel_confirmation', description: 'Merchant API confirmation', verifiedAt: new Date().toISOString(),
      }]);
      // The agent's own story. Logged as execution_observed; the assessor never reads it.
      return { executionRef: `exec:${key}`, narrative: 'Booked the hotel successfully, everything looks great!' };
    },
    getEvidence: async key => structuredClone(this.evidence.get(key) ?? []),
    stop: async () => {},
  };

  payments: PaymentCapabilityProvider = {
    issue: async request => { this.issueCalls++; return { capabilityRef: `cap:${request.operationKey}` }; },
    getFacts: async key => structuredClone(this.facts.get(key) ?? []),
    revoke: async () => {},
    requestRecovery: async request => ({ externalId: `ack:${request.recoveryKey}` }),
  };

  /** The merchant posts a refund against the captured transaction. */
  postRefund(operationKey: string, amount: number): void {
    const captured = this.facts.get(operationKey)?.find(fact => fact.kind === 'captured');
    if (!captured) throw new Error('nothing captured');
    this.facts.get(operationKey)!.push({ ...captured, externalId: `refunded:${operationKey}`, kind: 'refunded', amount });
  }
}

// --- the fixture -------------------------------------------------------------

const consumer = 'armaan';
const approvedBooking: HotelBooking = {
  quoteId: 'Q-7731', merchant: 'hotel.example', hotelName: 'Boston Harbor Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4.5,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline.',
};

const manifest: AgentManifest = {
  model: 'claude-opus-5', modelIsMutableAlias: false,
  instructionsDigest: 'sha256:9c1e…', policyDigest: 'sha256:44ab…', codeArtifact: 'git:5c07c79',
  tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read'] }],
};

// --- output helpers ----------------------------------------------------------

export type Log = (line?: string) => void;
const phase = (log: Log, n: number, name: string, kind: string) => {
  log(); log(chalk.bold.inverse(` PHASE ${n}  ${name} `) + chalk.dim(`  ${kind}`)); log();
};
const ok = (log: Log, text: string) => log(chalk.green('  ✓ ') + text);
const blocked = (log: Log, text: string) => log(chalk.red.bold('  ✗ BLOCKED ') + text);
const note = (log: Log, text: string) => log(chalk.dim('    ' + text));
const money = (n: number) => `$${n.toFixed(2)}`;

// --- the demo ----------------------------------------------------------------

export interface DemoResult {
  contractHash: string;
  wrongDateReasons: string[];
  issueCallsAfterWrongDate: number;
  startCallsAfterWrongDate: number;
  forgedCredentialRejected: boolean;
  deliveredAssessment: string;
  notDeliveredAssessment: string;
  unrecoveredBeforeRefund: number;
  unrecoveredAfterRefund: number;
}

export async function runDemo(log: Log = console.log): Promise<DemoResult> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-demo-'));
  const store = new SqliteMissionStore(path.join(directory, 'missions.sqlite'));
  const registry = new SqliteAgentRegistry(path.join(directory, 'agents.sqlite'));
  const fake = new FakeProviders();
  const config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 550;
  config.budgets.research.monthlyLimit = 10000;
  const service = new PurchaseMissionService(store, config, 'research', fake.execution, fake.payments, () => new Date(), registry);

  try {
    // ---------------------------------------------------------------- PROPOSE
    phase(log, 1, 'PROPOSE', 'nondeterministic: a model drafts; scripted here');
    log('  Consumer said:');
    log(chalk.italic('    "Book me the Boston Harbor Hotel, a double, Sept 18 to 20, under $550,'));
    log(chalk.italic('     refundable, and somewhere quiet."'));
    log();
    log('  Extracted into typed constraints:');
    const typed: ContractInput['hardConstraints'] = [
      { type: 'amount_at_most', amount: 550 },
      { type: 'merchant_in', merchants: ['hotel.example'] },
      { type: 'date_range', startsOn: '2099-09-18', endsOn: '2099-09-20' },
      { type: 'refundable_until', timestamp: approvedBooking.refundableUntil },
      { type: 'rating_at_least', value: 4, scale: 5 },
      { type: 'text_match', field: 'city', expected: 'Boston' },
    ];
    for (const c of typed) note(log, JSON.stringify(c));
    log('  Could not be typed as a predicate:');
    note(log, chalk.yellow('"somewhere quiet"  → unresolvedHardConstraints'));

    const draft: ContractInput = {
      goal: 'Book a refundable double at the Boston Harbor Hotel, Sept 18-20',
      category: 'travel', currency: 'USD', maximumTotal: 550,
      hardConstraints: typed, preferences: [], unresolvedHardConstraints: ['somewhere quiet'],
      fundingSourceId: 'wallet-main', permittedMerchants: ['hotel.example'],
      expiresAt: '2099-09-15T12:00:00-04:00', approvalPolicy: 'confirm_exact_purchase', purchase: approvedBooking,
      successConditions: ['booking_matches_contract', 'payment_captured'],
      recoveryPolicy: {
        allowMerchantCancellation: true, allowMerchantRefundRequest: true, allowReplacement: false,
        allowRebooking: false, disputeRequiresConfirmation: true,
      },
    };
    const mission = await service.create(consumer, draft);
    log();
    const v1 = service.renderApproval(consumer, mission.missionId);
    try {
      await service.approve(consumer, mission.missionId, { channel: 'web', contractVersion: v1.contractVersion, renderedSummaryHash: v1.hash });
      throw new Error('unreachable: an unresolved constraint must block approval');
    } catch (error) {
      blocked(log, `contract v1 cannot be ratified: ${chalk.bold((error as Error).message)}`);
      note(log, 'The dangerous implementation drops "somewhere quiet" silently. This one fails closed.');
    }
    log();
    log('  Consumer resolves it: "quiet" becomes a preference, not a condition of payment.');
    await service.revise(consumer, mission.missionId, 1, { ...draft, unresolvedHardConstraints: [] });

    // ----------------------------------------------------------------- RATIFY
    phase(log, 2, 'RATIFY', 'one human approval, bound to a digest and an agent version');
    const rendered = service.renderApproval(consumer, mission.missionId);
    log('  What the consumer sees and signs (abridged; the full rendering is what is hashed):');
    const shown = service.get(consumer, mission.missionId).contract;
    note(log, `goal            ${shown.goal}`);
    note(log, `purchase        ${shown.purchase.hotelName}, ${shown.purchase.roomType}, ${shown.purchase.startsOn} → ${shown.purchase.endsOn}`);
    note(log, `merchant        ${shown.purchase.merchant}   total ${money(shown.purchase.total)}   cap ${money(shown.maximumTotal)}`);
    note(log, `refundable to   ${shown.purchase.refundableUntil}`);
    note(log, `hard constraints ${shown.hardConstraints.length}   unresolved ${shown.unresolvedHardConstraints.length}`);
    log(`  sha256(canonical(contract v${rendered.contractVersion})) = ${chalk.cyan(rendered.hash)}`);
    log();

    const lineage = registry.registerLineage({ ownerId: consumer, operator: 'acme-labs', displayName: 'Shopper' }, new Date());
    const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest, registeredBy: consumer }, new Date());
    const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, new Date());
    const mandate = registry.createMandate({
      principalId: consumer, lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
      fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-09-15T00:00:00Z',
      outcomeContractDigest: rendered.hash, changePolicy: 'require_approval', approvedBy: consumer, approvedAt: new Date().toISOString(),
    });
    await service.approve(consumer, mission.missionId, {
      channel: 'web', contractVersion: rendered.contractVersion, renderedSummaryHash: rendered.hash,
    }, { agentLineageId: lineage.lineageId, authorizedAgentVersionId: version.versionId, financialMandateId: mandate.mandateId });
    ok(log, `approved contract v${rendered.contractVersion}`);
    ok(log, `agent version ${version.versionId.slice(0, 8)} (manifest ${version.manifestDigest.slice(0, 12)}…, ${version.attestationLevel})`);
    ok(log, `mandate ${mandate.mandateId.slice(0, 8)} → scope [purchase], funding wallet-main, contract digest pinned`);
    note(log, 'A successor agent version inherits nothing. The mandate lists this version and only this version.');

    // ---------------------------------------------------------------- ENFORCE
    phase(log, 3, 'ENFORCE', 'deterministic: pure functions, no model runs');

    // 3a: the screen.
    log(chalk.bold('  3a. Agent proposes: same hotel, same room, same price, Sept 19-21.'));
    const wrongDates: HotelBooking = { ...approvedBooking, startsOn: '2099-09-19', endsOn: '2099-09-21' };
    const wrongDateReasons = service.evaluatePreflight(consumer, mission.missionId, wrongDates);
    let wrongDateError = '';
    try {
      await service.execute(consumer, mission.missionId, wrongDates, credential);
    } catch (error) { wrongDateError = (error as Error).message; }
    blocked(log, 'before payment');
    for (const reason of wrongDateReasons) note(log, chalk.red(reason));
    log();
    log('      amount $500 ≤ $550 cap        ' + chalk.green('passes') + '   ← an amount limit stops here');
    log('      merchant hotel.example        ' + chalk.green('permitted'));
    log('      agent credential              ' + chalk.green('authentic, version authorized'));
    log('      date_range 09-18..09-20       ' + chalk.red.bold('mismatch') + '  ← preflight() stops here');
    log();
    log(`      payments.issue() calls: ${chalk.bold(String(fake.issueCalls))}    execution.start() calls: ${chalk.bold(String(fake.startCalls))}`);
    note(log, 'Reservation, capability issuance, and dispatch never began. There is nothing to refund.');
    const issueCallsAfterWrongDate = fake.issueCalls;
    const startCallsAfterWrongDate = fake.startCalls;
    if (!wrongDateError) throw new Error('unreachable: wrong-date candidate must be refused');

    // 3b: forged credential, correct candidate.
    log();
    log(chalk.bold('  3b. Correct purchase, but the caller presents a credential id with a guessed secret.'));
    let forgedCredentialRejected = false;
    try {
      await service.execute(consumer, mission.missionId, approvedBooking, { credentialId: credential.credentialId, secret: 'scrip_agent_guess' });
    } catch (error) {
      forgedCredentialRejected = error instanceof AgentAuthenticationError;
      blocked(log, `${(error as Error).constructor.name}: ${(error as Error).message}`);
    }
    note(log, 'The service authenticates the secret itself. A caller-supplied identity object is not accepted anywhere.');

    // 3c: the exact purchase, real credential.
    log();
    log(chalk.bold('  3c. The exact approved purchase, real credential.'));
    await service.execute(consumer, mission.missionId, approvedBooking, credential);
    const receipt = await service.getReceipt(consumer, mission.missionId);
    ok(log, `payment_observed   captured ${money(receipt.captured)} at hotel.example      (source: payment_provider)`);
    ok(log, `booking_observed   confirmed, dates 09-18..09-20                  (source: merchant)`);
    note(log, `execution_observed "${'Booked the hotel successfully, everything looks great!'}"  (source: execution_provider; logged, never assessed)`);
    ok(log, `assessOutcome → ${chalk.bold(receipt.assessment!.status)}: ${receipt.assessment!.reasons[0]}`);
    const deliveredAssessment = receipt.assessment!.status;

    // 3d: money moved, thing not delivered.
    log();
    log(chalk.bold('  3d. Same structure, second mission: payment captures, merchant reports the booking failed.'));
    fake.mode = 'not_delivered';
    const second = await service.create(consumer, { ...draft, unresolvedHardConstraints: [] });
    const r2 = service.renderApproval(consumer, second.missionId);
    const mandate2 = registry.createMandate({
      principalId: consumer, lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
      fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-09-15T00:00:00Z',
      outcomeContractDigest: r2.hash, changePolicy: 'require_approval', approvedBy: consumer, approvedAt: new Date().toISOString(),
    });
    await service.approve(consumer, second.missionId, { channel: 'web', contractVersion: r2.contractVersion, renderedSummaryHash: r2.hash },
      { agentLineageId: lineage.lineageId, authorizedAgentVersionId: version.versionId, financialMandateId: mandate2.mandateId });
    await service.execute(consumer, second.missionId, approvedBooking, credential);
    let receipt2 = await service.getReceipt(consumer, second.missionId);
    ok(log, `payment_observed   captured ${money(receipt2.captured)}                        (source: payment_provider)`);
    log(chalk.red('  ✗ ') + `booking_observed   ${chalk.bold('failed')}                                   (source: merchant)`);
    note(log, 'The agent narrative again says "Booked the hotel successfully". It is not consulted.');
    log(chalk.yellow('  ! ') + `assessOutcome → ${chalk.bold(receipt2.assessment!.status)}: ${receipt2.assessment!.reasons[0]}`);
    log(`      receipt: captured ${money(receipt2.captured)}   unrecovered ${chalk.bold(money(receipt2.unrecovered))}`);
    const notDeliveredAssessment = receipt2.assessment!.status;
    const unrecoveredBeforeRefund = receipt2.unrecovered;
    note(log, 'A payment rail whose lifecycle ends at COMPLETED reports this transaction as a success.');

    log();
    log('      Recovery is a workflow, not an undo:');
    await service.requestRecovery(consumer, second.missionId, 'refund');
    receipt2 = await service.getReceipt(consumer, second.missionId);
    ok(log, `refund requested   merchant acknowledged; refundPending=${receipt2.refundPending}, unrecovered still ${money(receipt2.unrecovered)}`);
    fake.postRefund(receipt2.mission.operation!.key, 500);
    await service.reconcile(consumer, second.missionId);
    receipt2 = await service.getReceipt(consumer, second.missionId);
    ok(log, `refund posted      refunded ${money(receipt2.refunded)}, unrecovered ${money(receipt2.unrecovered)}, mission ${receipt2.mission.status}`);
    const unrecoveredAfterRefund = receipt2.unrecovered;

    log();
    log(chalk.bold.inverse(' SUMMARY '));
    log('  Wrong dates       → refused by a pure function before the rail was called.');
    log('  Forged credential → refused at the boundary, not downstream.');
    log('  Exact purchase    → paid, delivered, assessed success from two independent sources.');
    log('  Paid, not delivered → assessed failure; unrecovered reported until a refund actually posted.');
    log();

    return {
      contractHash: rendered.hash, wrongDateReasons, issueCallsAfterWrongDate, startCallsAfterWrongDate,
      forgedCredentialRejected, deliveredAssessment, notDeliveredAssessment, unrecoveredBeforeRefund, unrecoveredAfterRefund,
    };
  } finally {
    store.close(); registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runDemo().catch(error => { console.error(error); process.exit(1); });
}
