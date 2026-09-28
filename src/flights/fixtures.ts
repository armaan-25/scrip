/**
 * Demo data. Schedules are shaped like real JFK/SFO service but the carrier
 * is fictional and fares are illustrative.
 */
import type { FlightOffer, FlightRequirements } from './types.js';

export const demoRequest = 'Book me a flight NYC to SF, Friday Oct 16, back Sunday Oct 18. Direct only, refundable, under $600.';

export const confirmedRequirements: FlightRequirements = {
  from: 'JFK', to: 'SFO', departOn: '2026-10-16', returnOn: '2026-10-18',
  directOnly: true, refundableOnly: true, maxTotalCents: 60000,
};

export const nonstopOffer: FlightOffer = {
  offerId: 'offer-nonstop', carrier: 'Example Air', refundable: true, totalCents: 55900, currency: 'USD',
  outbound: [{ flight: 'EX 668', from: 'JFK', to: 'SFO', departAt: '2026-10-16T07:00:00-04:00', arriveAt: '2026-10-16T10:17:00-07:00' }],
  inbound: [{ flight: 'EX 405', from: 'SFO', to: 'JFK', departAt: '2026-10-18T07:00:00-07:00', arriveAt: '2026-10-18T15:37:00-04:00' }],
};

/** Cheaper, but a 6h12m layover out, 8h32m back, and no refunds. */
export const layoverOffer: FlightOffer = {
  offerId: 'offer-layover', carrier: 'Example Air', refundable: false, totalCents: 38900, currency: 'USD',
  outbound: [
    { flight: 'EX 892', from: 'JFK', to: 'SLC', departAt: '2026-10-16T06:00:00-04:00', arriveAt: '2026-10-16T09:08:00-06:00' },
    { flight: 'EX 1088', from: 'SLC', to: 'SFO', departAt: '2026-10-16T15:20:00-06:00', arriveAt: '2026-10-16T16:24:00-07:00' },
  ],
  inbound: [
    { flight: 'EX 1331', from: 'SFO', to: 'SLC', departAt: '2026-10-18T05:45:00-07:00', arriveAt: '2026-10-18T08:38:00-06:00' },
    { flight: 'EX 697', from: 'SLC', to: 'JFK', departAt: '2026-10-18T17:10:00-06:00', arriveAt: '2026-10-18T23:40:00-04:00' },
  ],
};
