import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorizeCard, purchaseDigest, signOrder, verifyMerchantOrder } from '../src/cards/card-gate.js';
import type { CardAuthorizationRequest, CardBinding, SignedMerchantOrder } from '../src/cards/types.js';
import type { HotelBooking } from '../src/missions/types.js';

const approved: HotelBooking = {
  quoteId: 'Q-1', merchant: 'hotel.example', hotelName: 'Harborview Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4.5,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline.',
};
const binding: CardBinding = {
  cardRef: 'simcard_1', last4: 'rd_1', operationKey: 'op-1', merchantId: 'hotel.example', purchaseDigest: purchaseDigest(approved),
  merchantDescriptors: ['HARBORVIEW HOTEL'], ceiling: 550, exactTotal: 500, currency: 'USD',
  notBefore: '2099-01-01T00:00:00Z', expiresAt: '2099-09-15T12:00:00-04:00', singleUse: true, status: 'active',
};
const now = new Date('2099-06-01T00:00:00Z');
const KEY = 'shared-key';
const base: CardAuthorizationRequest = {
  cardRef: 'simcard_1', merchantDescriptor: 'HARBORVIEW HOTEL', mcc: '7011', amount: 500, currency: 'USD', occurredAt: now.toISOString(),
};
function order(booking: HotelBooking, sig?: string): SignedMerchantOrder {
  const unsigned = { merchantId: 'hotel.example', orderRef: 'o-1', booking, digest: purchaseDigest(booking) };
  return { ...unsigned, signature: sig ?? signOrder(unsigned, KEY) };
}

describe('issuer gate: authorization tier', () => {
  it('approves a charge inside every constraint', () => {
    expect(authorizeCard(binding, base, now, 'a1')).toEqual({ approved: true, tier: 'authorization', authRef: 'a1' });
  });
  it.each([
    ['merchant', { merchantDescriptor: 'OTHER HOTEL' }, 'Merchant descriptor not permitted'],
    ['amount', { amount: 551 }, 'Amount exceeds ceiling'],
    ['currency', { currency: 'EUR' as unknown as 'USD' }, 'Currency mismatch'],
  ])('declines a %s violation with exactly one reason', (_name, patch, reason) => {
    const decision = authorizeCard(binding, { ...base, ...patch }, now, 'a2');
    expect(decision).toEqual({ approved: false, tier: 'authorization', authRef: 'a2', reasons: [reason] });
  });
  it('declines outside the window', () => {
    const decision = authorizeCard(binding, base, new Date('2099-09-16T00:00:00Z'), 'a3');
    expect(decision.approved).toBe(false);
    if (!decision.approved) expect(decision.reasons).toEqual(['Card window closed']);
  });
  it('declines a used or frozen card before any other check', () => {
    for (const status of ['used', 'frozen'] as const) {
      const decision = authorizeCard({ ...binding, status }, { ...base, amount: 9999 }, now, 'a4');
      expect(decision.approved).toBe(false);
      if (!decision.approved) expect(decision.reasons).toEqual([`Card is ${status}`]);
    }
  });
  it('accumulates every authorization-tier reason', () => {
    const decision = authorizeCard(binding, { ...base, merchantDescriptor: 'X', amount: 600 }, now, 'a5');
    if (decision.approved) throw new Error('expected decline');
    expect(decision.reasons).toEqual(['Merchant descriptor not permitted', 'Amount exceeds ceiling']);
  });
});

describe('issuer gate: order tier', () => {
  it('approves when the signed order matches the approved purchase exactly', () => {
    expect(authorizeCard(binding, { ...base, order: order(approved) }, now, 'o1', { sharedKey: KEY }))
      .toEqual({ approved: true, tier: 'order', authRef: 'o1' });
  });
  it('declines a same-merchant, same-price order with different dates before capture', () => {
    const drifted = { ...approved, startsOn: '2099-09-19', endsOn: '2099-09-21' };
    const decision = authorizeCard(binding, { ...base, order: order(drifted) }, now, 'o2', { sharedKey: KEY });
    expect(decision).toEqual({ approved: false, tier: 'order', authRef: 'o2', reasons: ['Order does not match the approved purchase'] });
  });
  it('declines a different room at the same price', () => {
    const decision = authorizeCard(binding, { ...base, order: order({ ...approved, roomType: 'Suite' }) }, now, 'o3', { sharedKey: KEY });
    if (decision.approved) throw new Error('expected decline');
    expect(decision.reasons).toEqual(['Order does not match the approved purchase']);
  });
  it('rejects a forged signature before looking at the order', () => {
    const decision = authorizeCard(binding, { ...base, order: order(approved, 'ff'.repeat(32)) }, now, 'o4', { sharedKey: KEY });
    if (decision.approved) throw new Error('expected decline');
    expect(decision.reasons).toEqual(['Merchant order signature invalid']);
  });
  it('rejects an order whose digest is not the digest of its contents', () => {
    const lying = { ...order({ ...approved, roomType: 'Suite' }), digest: binding.purchaseDigest };
    lying.signature = signOrder(lying, KEY);
    expect(verifyMerchantOrder(binding, { ...base, order: lying }, KEY)).toEqual(['Order digest does not match its contents']);
  });
  it('requires the exact total at the order tier even under the ceiling', () => {
    expect(verifyMerchantOrder(binding, { ...base, amount: 480, order: order(approved) }, KEY)).toEqual(['Amount differs from the approved total']);
  });
  it('declines when the issuer has no key for the merchant that sent an order', () => {
    const decision = authorizeCard(binding, { ...base, order: order(approved) }, now, 'o5');
    if (decision.approved) throw new Error('expected decline');
    expect(decision.reasons).toEqual(['Issuer has no order-verification key for this merchant']);
  });
});

describe('issuer domain boundary', () => {
  it('the gate and the rail import nothing from the mission service, registry, or store', () => {
    for (const file of ['src/cards/card-gate.ts', 'src/cards/simulated-rail.ts', 'src/cards/types.ts']) {
      const imports = fs.readFileSync(file, 'utf8').split('\n').filter(l => /^import .* from '\.\.\/missions\//.test(l));
      for (const line of imports) {
        expect(line).not.toMatch(/agent-registry|mission-store|purchase-mission-service|agent-identity/);
        expect(line).toMatch(/\/types\.js'|\/outcome-assessor\.js'/);
      }
    }
  });
});
