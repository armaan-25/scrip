/**
 * The issuer-side gate. Pure functions only: no I/O, no clock other than
 * the `now` argument, and no imports from the mission service, registry, or
 * store. This is the piece a real card issuer would run inside its
 * authorization path, so it is written to use only what an issuer has.
 *
 * Two tiers:
 *   authorization - what every issuer can check from the network message:
 *                   merchant descriptor, amount, currency, window, single use.
 *   order         - only when the merchant sent a signed order: the order's
 *                   fingerprint must equal the approved purchase's.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonical } from '../missions/outcome-assessor.js';
import type { HotelBooking } from '../missions/types.js';
import type {
  CardAuthorizationDecision, CardAuthorizationRequest, CardBinding, SignedMerchantOrder,
} from './types.js';

export function purchaseDigest(booking: HotelBooking): string {
  return createHash('sha256').update(canonical(booking)).digest('hex');
}

export function signOrder(order: Omit<SignedMerchantOrder, 'signature'>, sharedKey: string): string {
  return createHmac('sha256', sharedKey).update(`${order.merchantId}\n${order.orderRef}\n${order.digest}`).digest('hex');
}

function signatureValid(order: SignedMerchantOrder, sharedKey: string): boolean {
  const expected = Buffer.from(signOrder(order, sharedKey), 'hex');
  const actual = Buffer.from(order.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Order tier. Assumes the authorization tier already passed. Checks, in
 * order: the signature (so an unintegrated party cannot forge an order),
 * that the digest really is the digest of the order contents, that it
 * equals the approved purchase's digest, and that the amount is exact.
 */
export function verifyMerchantOrder(
  binding: CardBinding, request: CardAuthorizationRequest & { order: SignedMerchantOrder }, sharedKey: string,
): string[] {
  const order = request.order;
  if (!signatureValid(order, sharedKey)) return ['Merchant order signature invalid'];
  const reasons: string[] = [];
  if (purchaseDigest(order.booking) !== order.digest) reasons.push('Order digest does not match its contents');
  else if (order.digest !== binding.purchaseDigest) reasons.push('Order does not match the approved purchase');
  if (request.amount !== binding.exactTotal) reasons.push('Amount differs from the approved total');
  return reasons;
}

export function authorizeCard(
  binding: CardBinding, request: CardAuthorizationRequest, now: Date, authRef: string,
  options: { sharedKey?: string } = {},
): CardAuthorizationDecision {
  const tier = request.order ? 'order' : 'authorization';
  if (binding.status !== 'active') return { approved: false, tier, authRef, reasons: [`Card is ${binding.status}`] };
  const reasons: string[] = [];
  const t = now.getTime();
  if (t < Date.parse(binding.notBefore) || t >= Date.parse(binding.expiresAt)) reasons.push('Card window closed');
  if (request.currency !== binding.currency) reasons.push('Currency mismatch');
  if (!binding.merchantDescriptors.includes(request.merchantDescriptor)) reasons.push('Merchant descriptor not permitted');
  if (request.amount > binding.ceiling) reasons.push('Amount exceeds ceiling');
  if (reasons.length) return { approved: false, tier, authRef, reasons };
  if (request.order) {
    if (!options.sharedKey) return { approved: false, tier, authRef, reasons: ['Issuer has no order-verification key for this merchant'] };
    const orderReasons = verifyMerchantOrder(binding, { ...request, order: request.order }, options.sharedKey);
    if (orderReasons.length) return { approved: false, tier, authRef, reasons: orderReasons };
  }
  return { approved: true, tier, authRef };
}
