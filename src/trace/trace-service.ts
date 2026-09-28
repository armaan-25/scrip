/**
 * One purchase from the person's words to a paid (or refused) flight.
 * Reuses Scrip's agent registry (only the approved agent version may buy)
 * and budget ledger (the cost is held until the payment settles).
 */
import { randomUUID } from 'node:crypto';
import { checkOffer, diffRequirements, type RequirementDifference } from '../flights/rules.js';
import type { FlightOffer, FlightRequirements } from '../flights/types.js';
import type { TaskAuthorizationManager } from '../lease.js';
import type { AuthenticatedAgent } from '../missions/agent-identity.js';
import type { SqliteAgentRegistry } from '../missions/agent-registry.js';
import type { RecordedEvent, TraceEvent } from './events.js';
import { orderFingerprint } from './fingerprint.js';
import type { SqliteTraceStore } from './trace-store.js';

export type PurchaseDecision = { approved: true; fingerprint: string; totalCents: number } | { approved: false; reasons: string[] };
export interface ApprovedPurchase { fingerprint: string; totalCents: number; naturalAgentId: string }

type Data<T extends TraceEvent['type']> = Extract<TraceEvent, { type: T }>['data'];

export interface TraceDeps {
  store: SqliteTraceStore;
  registry: SqliteAgentRegistry;
  ledger: TaskAuthorizationManager;
  budget: string;
  now: () => Date;
}

export class FlightTraceService {
  constructor(private deps: TraceDeps) {}

  start(consumerId: string, words: string): string {
    const traceId = `trc_${randomUUID()}`;
    this.append(traceId, { type: 'request_received', data: { consumerId, words } });
    return traceId;
  }

  confirm(traceId: string, requirements: FlightRequirements): string {
    const requirementsDigest = orderFingerprint(requirements);
    this.append(traceId, { type: 'requirements_confirmed', data: { requirements, requirementsDigest } });
    return requirementsDigest;
  }

  recordInterpretation(traceId: string, agent: AuthenticatedAgent, interpretation: FlightRequirements): RequirementDifference[] {
    const confirmed = this.confirmed(traceId);
    this.append(traceId, { type: 'agent_interpretation_recorded', data: { agentVersionId: agent.versionId, interpretation } });
    const differences = diffRequirements(confirmed.requirements, interpretation);
    this.append(traceId, { type: 'interpretation_compared', data: { differences } });
    return differences;
  }

  async proposePurchase(
    traceId: string, agent: AuthenticatedAgent, mandateId: string, offer: FlightOffer, naturalAgentId: string,
  ): Promise<PurchaseDecision> {
    const confirmed = this.confirmed(traceId);
    const violations = checkOffer(confirmed.requirements, offer);
    this.append(traceId, { type: 'candidate_checked', data: { offer, violations } });
    if (violations.length) return this.refuse(traceId, violations.map(v => `${v.rule}: ${v.detail}`));

    const authority = this.deps.registry.authorize(agent, mandateId, confirmed.requirementsDigest, this.deps.now(), { operation: 'purchase' });
    if (!authority.allowed) return this.refuse(traceId, authority.reasons);

    const dollars = offer.totalCents / 100;
    const task = await this.deps.ledger.authorizeTask({ budget: this.deps.budget, taskId: traceId, task: `flight ${offer.offerId}`, allowance: dollars });
    const reservation = this.deps.ledger.reserveAction(task.credential, 'purchase', offer.offerId, dollars, { traceId });
    const fingerprint = orderFingerprint(offer);
    this.append(traceId, {
      type: 'purchase_approved',
      data: { offer, fingerprint, totalCents: offer.totalCents, naturalAgentId, authorizationId: task.authorization.authorizationId, reservationId: reservation.reservationId },
    });
    return { approved: true, fingerprint, totalCents: offer.totalCents };
  }

  recordPaymentSubmitted(traceId: string, data: Data<'payment_submitted'>): void { this.append(traceId, { type: 'payment_submitted', data }); }
  recordHold(traceId: string, data: Data<'payment_held'>): void { this.append(traceId, { type: 'payment_held', data }); }
  recordDecision(traceId: string, data: Data<'hold_decided'>): void { this.append(traceId, { type: 'hold_decided', data }); }

  /** Final Natural status. Spends the reserved budget on COMPLETED; releases it on anything else. */
  recordSettlement(traceId: string, data: Data<'payment_settled'>): void {
    const approved = this.find(traceId, 'purchase_approved');
    const alreadySettled = this.events(traceId).some(e => e.type === 'payment_settled');
    this.append(traceId, { type: 'payment_settled', data });
    if (!approved || alreadySettled) return;
    if (data.status === 'COMPLETED') this.deps.ledger.commitAction(approved.reservationId, approved.totalCents / 100);
    else this.deps.ledger.cancelAction(approved.reservationId);
  }

  exists(traceId: string): boolean { return this.deps.store.exists(traceId); }
  events(traceId: string): RecordedEvent[] { return this.deps.store.events(traceId); }

  approvedPurchase(traceId: string): ApprovedPurchase | undefined {
    const approved = this.find(traceId, 'purchase_approved');
    return approved && { fingerprint: approved.fingerprint, totalCents: approved.totalCents, naturalAgentId: approved.naturalAgentId };
  }

  isHoldRecorded(traceId: string, approvalId: string): boolean {
    return this.events(traceId).some(e => e.type === 'payment_held' && e.data.approvalId === approvalId);
  }

  isHoldDecided(traceId: string, approvalId: string): boolean {
    return this.events(traceId).some(e => e.type === 'hold_decided' && e.data.approvalId === approvalId);
  }

  hasApprovedPayment(traceId: string): boolean {
    return this.events(traceId).some(e => e.type === 'hold_decided' && e.data.decision === 'approved');
  }

  private refuse(traceId: string, reasons: string[]): PurchaseDecision {
    this.append(traceId, { type: 'purchase_refused', data: { reasons } });
    return { approved: false, reasons };
  }

  private confirmed(traceId: string): Data<'requirements_confirmed'> {
    const confirmed = this.find(traceId, 'requirements_confirmed');
    if (!confirmed) throw new Error('Requirements must be confirmed by the person first');
    return confirmed;
  }

  private find<T extends TraceEvent['type']>(traceId: string, type: T): Data<T> | undefined {
    const hit = this.events(traceId).filter(e => e.type === type).at(-1);
    return hit?.data as Data<T> | undefined;
  }

  private append(traceId: string, event: TraceEvent): void { this.deps.store.append(traceId, event, this.deps.now()); }
}
