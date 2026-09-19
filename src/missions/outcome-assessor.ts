import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HotelBooking, MissionEvent, OutcomeAssessment, OutcomeContract, OutcomeConstraint } from './types.js';

const money = z.number().finite().nonnegative().refine(value =>
  Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6);
const timestamp = z.string().datetime({ offset: true });
const date = z.string().date();
export const hotelSchema = z.object({
  quoteId: z.string().min(1), merchant: z.string().min(1), hotelName: z.string().min(1),
  roomType: z.string().min(1), city: z.string().min(1), startsOn: date, endsOn: date,
  total: money.refine(value => value > 0), currency: z.literal('USD'),
  rating: z.number().finite().min(0).max(5), refundableUntil: timestamp,
  cancellationTerms: z.string().min(1),
}).strict().refine(value => value.startsOn < value.endsOn, 'Invalid stay dates');

const constraintSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('amount_at_most'), amount: money }),
  z.object({ type: z.literal('merchant_in'), merchants: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('date_range'), startsOn: date, endsOn: date }),
  z.object({ type: z.literal('refundable_until'), timestamp }),
  z.object({ type: z.literal('rating_at_least'), value: z.number().min(0).max(5), scale: z.literal(5) }),
  z.object({ type: z.literal('text_match'), field: z.enum(['city', 'hotelName', 'roomType']), expected: z.string().min(1) }),
]);

export const contractSchema = z.object({
  goal: z.string().min(1), category: z.literal('travel'), currency: z.literal('USD'),
  maximumTotal: money.refine(value => value > 0), hardConstraints: z.array(z.unknown()),
  preferences: z.array(z.unknown()), unresolvedHardConstraints: z.array(z.string()),
  fundingSourceId: z.string().optional(),
  permittedMerchants: z.array(z.string().min(1)).min(1).optional(), expiresAt: timestamp,
  approvalPolicy: z.literal('confirm_exact_purchase'), purchase: hotelSchema,
  successConditions: z.array(z.enum(['booking_matches_contract', 'payment_captured'])).min(1),
  recoveryPolicy: z.object({
    allowMerchantCancellation: z.boolean(), allowMerchantRefundRequest: z.boolean(),
    allowReplacement: z.boolean(), allowRebooking: z.boolean(), disputeRequiresConfirmation: z.literal(true),
    recoveryDeadline: timestamp.optional(),
  }).strict(),
}).strict();

export const paymentSchema = z.object({
  externalId: z.string().min(1), operationKey: z.string().min(1), transactionRef: z.string().min(1),
  kind: z.enum(['authorized', 'captured', 'unpaid', 'reversed', 'refund_acknowledged', 'refunded']),
  amount: money, currency: z.literal('USD'), merchant: z.string().min(1),
}).strict();

export const bookingEvidenceSchema = z.object({
  source: z.enum(['merchant', 'email']), externalId: z.string().min(1), operationKey: z.string().min(1),
  bookingRef: z.string().min(1), status: z.enum(['confirmed', 'failed', 'cancelled']), booking: hotelSchema,
  type: z.string().min(1), description: z.string(), verifiedAt: timestamp,
  data: z.record(z.unknown()).optional(),
}).strict();

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function renderContract(contract: OutcomeContract): { summary: string; hash: string } {
  const { approvalEvidence: _approval, ...terms } = contract;
  const summary = JSON.stringify(JSON.parse(canonical(terms)), null, 2);
  return { summary, hash: createHash('sha256').update(summary).digest('hex') };
}

function matches(constraint: OutcomeConstraint, booking: HotelBooking): boolean {
  switch (constraint.type) {
    case 'amount_at_most': return booking.total <= constraint.amount;
    case 'merchant_in': return constraint.merchants.includes(booking.merchant);
    case 'date_range': return booking.startsOn === constraint.startsOn && booking.endsOn === constraint.endsOn;
    case 'refundable_until': return Date.parse(booking.refundableUntil) >= Date.parse(constraint.timestamp);
    case 'rating_at_least': return booking.rating >= constraint.value;
    case 'text_match': return booking[constraint.field] === constraint.expected;
  }
}

export function preflight(contract: OutcomeContract, candidate: HotelBooking, now: Date): string[] {
  const reasons: string[] = [];
  if (!hotelSchema.safeParse(candidate).success) return ['Invalid or unresolved hotel quote'];
  if (Date.parse(contract.expiresAt) <= now.getTime()) reasons.push('Contract expired');
  if (contract.unresolvedHardConstraints.length) reasons.push('Unresolved hard constraints');
  if (!contract.successConditions.includes('booking_matches_contract') || !contract.successConditions.includes('payment_captured')) {
    reasons.push('Hotel verification requires booking and payment conditions');
  }
  if (candidate.total > contract.maximumTotal) reasons.push('Amount exceeds maximum');
  if (contract.permittedMerchants && !contract.permittedMerchants.includes(candidate.merchant)) reasons.push('Merchant not permitted');
  for (const constraint of contract.hardConstraints) {
    const parsed = constraintSchema.safeParse(constraint);
    if (!parsed.success) reasons.push('Unknown or unresolved hard constraint');
    else if (!matches(parsed.data, candidate)) reasons.push(`Constraint mismatch: ${parsed.data.type}`);
  }
  if (canonical(candidate) !== canonical(contract.purchase)) reasons.push('Exact purchase changed; revise and approve a new version');
  return reasons;
}

export function assessOutcome(contract: OutcomeContract, events: MissionEvent[]): OutcomeAssessment {
  const bookings = events.filter(event => event.type === 'booking_observed');
  const payments = events.filter(event => event.type === 'payment_observed').map(event => event.data);
  // Expiry stops new spending; it does not invalidate evidence about an earlier purchase.
  const matchesBooking = (booking: HotelBooking) => preflight(contract, booking, new Date(0)).length === 0;
  const good = bookings.filter(event => event.data.status === 'confirmed' && matchesBooking(event.data.booking));
  const bad = bookings.filter(event => event.data.status !== 'confirmed' || !matchesBooking(event.data.booking));
  if ((good.length && bad.length) || new Set(bookings.map(event => event.data.bookingRef)).size > 1) {
    return { status: 'unknown', reasons: ['Conflicting independent booking evidence; consumer review required'] };
  }
  if (bad.length || payments.some(fact => fact.kind === 'unpaid')) {
    return { status: 'failure', reasons: ['Supported hotel outcome failed'] };
  }
  const captures = payments.filter(fact => fact.kind === 'captured');
  if (captures.some(fact => fact.amount !== contract.purchase.total || fact.merchant !== contract.purchase.merchant)) {
    return { status: 'failure', reasons: ['Captured payment differs from the approved purchase'] };
  }
  if (!good.length || !captures.length) return { status: 'pending', reasons: ['Awaiting independent booking and capture evidence'] };
  if (payments.some(fact => fact.kind === 'refunded' || fact.kind === 'reversed')) {
    return { status: 'failure', reasons: ['Purchase was recovered; retain the recovery outcome'] };
  }
  return { status: 'success', reasons: ['Independent booking and payment facts match the approved contract'] };
}

export function paymentTotals(events: MissionEvent[]) {
  const sum = (kind: string) => events.reduce((total, event) =>
    total + (event.type === 'payment_observed' && event.data.kind === kind ? Math.round(event.data.amount * 100) : 0), 0) / 100;
  const captured = sum('captured');
  const refunded = sum('refunded');
  const reversed = sum('reversed');
  return { captured, refunded, reversed, netSpend: Math.round((captured - refunded - reversed) * 100) / 100 };
}
