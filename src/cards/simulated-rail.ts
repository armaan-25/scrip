/**
 * SIMULATED card rail: an issuer, and two merchants.
 *
 * Nothing here talks to a network or moves money. The issuer holds card
 * bindings and runs the gate (card-gate.ts) on every authorization. The
 * two merchants differ in exactly one way: SimulatedAcceptMerchant is
 * integrated with the issuer and sends a signed order before the charge;
 * SimulatedWebMerchant is not, and only the network message arrives.
 *
 * Declined authorizations are logged but produce no PaymentFact: nothing
 * moved, so there is nothing for the mission ledger to record. The
 * mission is closed by the operator (service.cancel()) if it should not
 * be retried.
 */
import { randomUUID } from 'node:crypto';
import type { BookingEvidence, HotelBooking, PaymentFact } from '../missions/types.js';
import { authorizeCard, purchaseDigest, signOrder } from './card-gate.js';
import type { CardAuthorizationDecision, CardAuthorizationRequest, CardBinding, SignedMerchantOrder } from './types.js';

export interface AuthorizationRecord {
  authRef: string;
  operationKey: string;
  request: CardAuthorizationRequest;
  decision: CardAuthorizationDecision;
  decidedAt: string;
  captured?: PaymentFact;
}

export class SimulatedIssuer {
  readonly label = 'SIMULATED issuer';
  private bindings = new Map<string, CardBinding>();
  private records = new Map<string, AuthorizationRecord>();
  private factsByOperation = new Map<string, PaymentFact[]>();
  private orderKeys = new Map<string, string>();

  constructor(private now: () => Date = () => new Date()) {}

  /** A merchant integrated with this issuer shares a key for signing orders. */
  registerIntegratedMerchant(merchantId: string, sharedKey: string): void {
    this.orderKeys.set(merchantId, sharedKey);
  }

  issue(input: Omit<CardBinding, 'cardRef' | 'last4' | 'status'>): CardBinding {
    const cardRef = `simcard_${randomUUID()}`;
    const binding: CardBinding = { ...input, cardRef, last4: cardRef.slice(-4), status: 'active' };
    this.bindings.set(cardRef, binding);
    return structuredClone(binding);
  }

  binding(cardRef: string): CardBinding | undefined {
    const b = this.bindings.get(cardRef);
    return b ? structuredClone(b) : undefined;
  }

  freeze(cardRef: string): void {
    const b = this.bindings.get(cardRef);
    if (b && b.status === 'active') b.status = 'frozen';
  }

  freezeOperation(operationKey: string): void {
    for (const b of this.bindings.values()) if (b.operationKey === operationKey) this.freeze(b.cardRef);
  }

  /** The network asks: approve or decline? */
  authorize(request: CardAuthorizationRequest): CardAuthorizationDecision {
    const authRef = `simauth_${randomUUID()}`;
    const binding = this.bindings.get(request.cardRef);
    if (!binding) return { approved: false, tier: 'authorization', authRef, reasons: ['Unknown card'] };
    const sharedKey = request.order ? this.orderKeys.get(request.order.merchantId) : undefined;
    const decision = authorizeCard(binding, request, this.now(), authRef, { sharedKey });
    if (decision.approved) binding.status = 'used';
    this.records.set(authRef, {
      authRef, operationKey: binding.operationKey, request: structuredClone(request), decision, decidedAt: this.now().toISOString(),
    });
    return decision;
  }

  /** Merchant captures an approved authorization: money moves. */
  capture(authRef: string): PaymentFact {
    const record = this.records.get(authRef);
    if (!record || !record.decision.approved) throw new Error('Cannot capture a declined or unknown authorization');
    if (record.captured) return structuredClone(record.captured);
    const fact: PaymentFact = {
      externalId: `simcap_${authRef}`, operationKey: record.operationKey, transactionRef: `simtx_${authRef}`,
      kind: 'captured', amount: record.request.amount, currency: 'USD', merchant: this.merchantFor(record),
    };
    record.captured = fact;
    this.push(record.operationKey, fact);
    return structuredClone(fact);
  }

  /** SIMULATED provider evidence that returned funds actually posted. */
  refund(authRef: string, amount: number): PaymentFact {
    const record = this.records.get(authRef);
    if (!record?.captured) throw new Error('Nothing captured to refund');
    const fact: PaymentFact = { ...record.captured, externalId: `simref_${authRef}_${amount}`, kind: 'refunded', amount };
    this.push(record.operationKey, fact);
    return structuredClone(fact);
  }

  facts(operationKey: string): PaymentFact[] { return structuredClone(this.factsByOperation.get(operationKey) ?? []); }
  decisions(operationKey: string): AuthorizationRecord[] {
    return [...this.records.values()].filter(r => r.operationKey === operationKey).map(r => structuredClone(r));
  }

  /** The ledger names merchants by id, not by network descriptor; the binding carries the id. */
  private merchantFor(record: AuthorizationRecord): string {
    return this.bindings.get(record.request.cardRef)!.merchantId;
  }

  private push(operationKey: string, fact: PaymentFact): void {
    this.factsByOperation.set(operationKey, [...(this.factsByOperation.get(operationKey) ?? []), fact]);
  }
}

export interface CheckoutResult {
  decision: CardAuthorizationDecision;
  /** What the merchant reports it fulfilled. Absent when declined. */
  evidence?: BookingEvidence;
}

interface MerchantOptions { merchantId: string; descriptor: string; mcc: string }

/**
 * SIMULATED merchant integrated with the issuer. Sends a signed order
 * with every authorization, and reports fulfillment through a merchant API
 * (evidence source 'merchant').
 */
export class SimulatedAcceptMerchant {
  readonly label = 'SIMULATED merchant (integrated: sends signed orders)';
  constructor(private issuer: SimulatedIssuer, private options: MerchantOptions & { sharedKey: string }, private now: () => Date = () => new Date()) {
    issuer.registerIntegratedMerchant(options.merchantId, options.sharedKey);
  }

  /** `booking` is what the merchant is actually about to sell. */
  checkout(cardRef: string, booking: HotelBooking, opts: { forgeSignature?: boolean } = {}): CheckoutResult {
    const orderRef = `order_${randomUUID().slice(0, 8)}`;
    const unsigned = { merchantId: this.options.merchantId, orderRef, booking: structuredClone(booking), digest: purchaseDigest(booking) };
    const order: SignedMerchantOrder = { ...unsigned, signature: opts.forgeSignature ? 'ff'.repeat(32) : signOrder(unsigned, this.options.sharedKey) };
    const decision = this.issuer.authorize({
      cardRef, merchantDescriptor: this.options.descriptor, mcc: this.options.mcc, amount: booking.total, currency: 'USD',
      occurredAt: this.now().toISOString(), order,
    });
    if (!decision.approved) return { decision };
    const captured = this.issuer.capture(decision.authRef);
    return {
      decision,
      evidence: {
        source: 'merchant', externalId: `simfulfil_${orderRef}`, operationKey: captured.operationKey, bookingRef: orderRef,
        status: 'confirmed', booking: structuredClone(booking), type: 'hotel_confirmation',
        description: 'SIMULATED merchant API confirmation', verifiedAt: this.now().toISOString(),
      },
    };
  }
}

/**
 * SIMULATED merchant on the open web. No integration: the issuer sees only
 * the network message. Fulfillment arrives later as a confirmation email
 * (evidence source 'email'), already parsed into the typed shape.
 */
export class SimulatedWebMerchant {
  readonly label = 'SIMULATED merchant (not integrated: no order data)';
  constructor(private issuer: SimulatedIssuer, private options: MerchantOptions, private now: () => Date = () => new Date()) {}

  checkout(cardRef: string, booking: HotelBooking): CheckoutResult {
    const decision = this.issuer.authorize({
      cardRef, merchantDescriptor: this.options.descriptor, mcc: this.options.mcc, amount: booking.total, currency: 'USD',
      occurredAt: this.now().toISOString(),
    });
    if (!decision.approved) return { decision };
    const captured = this.issuer.capture(decision.authRef);
    const confirmation = `conf_${randomUUID().slice(0, 8)}`;
    return {
      decision,
      evidence: {
        source: 'email', externalId: `simemail_${confirmation}`, operationKey: captured.operationKey, bookingRef: confirmation,
        status: 'confirmed', booking: structuredClone(booking), type: 'hotel_confirmation',
        description: 'SIMULATED confirmation email, parsed', verifiedAt: this.now().toISOString(),
      },
    };
  }
}
