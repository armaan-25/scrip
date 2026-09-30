import { describe, expect, it } from 'vitest';
import { decideCheckout } from '../src/agent/checkout.js';
import { confirmedRequirements } from '../src/flights/fixtures.js';
import type { FlightOffer } from '../src/flights/types.js';

const req = { ...confirmedRequirements, refundableOnly: false, maxTotalCents: 70000 };
const offer: FlightOffer = {
  offerId: 'web-1', carrier: 'JetBlue', refundable: false, totalCents: 56800, currency: 'USD',
  outbound: [{ flight: 'B6 115', from: 'JFK', to: 'SFO', departAt: '2026-10-16T06:00', arriveAt: '2026-10-16T09:15' }],
  inbound: [{ flight: 'B6 216', from: 'SFO', to: 'JFK', departAt: '2026-10-18T11:49', arriveAt: '2026-10-18T20:34' }],
};

describe('decideCheckout', () => {
  it('holds the real $568 case for review: $234 + $334 were seen, $568 never was', () => {
    const v = decideCheckout(req, offer, 'JetBlue JFK-SFO from $234 ... SFO-JFK from $334. B6115 06:00. B6216 11:49.', 'blocker');
    expect(v).toMatchObject({ decision: 'in_review', blockerDecision: 'in_review', reasons: ['not found in anything the agent read: price $568.00'] });
  });

  it('accepts when the price and flights were seen, and rejects a flight over budget', () => {
    expect(decideCheckout(req, offer, 'B6 115 / B6 216 round trip $568', 'blocker').decision).toBe('accepted');
    expect(decideCheckout(req, { ...offer, totalCents: 90000 }, 'B6 115 / B6 216 $900', 'blocker')).toMatchObject({ decision: 'rejected' });
  });

  it('observer mode always accepts but keeps what blocker would have decided', () => {
    expect(decideCheckout(req, { ...offer, totalCents: 90000 }, '', 'observer')).toMatchObject({ decision: 'accepted', blockerDecision: 'rejected' });
  });
});
