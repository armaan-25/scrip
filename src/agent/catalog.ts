/**
 * The simulated seller's catalog the real agent searches. Offers are shaped
 * like real JFK/SFO service; the carrier is fictional and fares illustrative.
 * The fingerprint Scrip checks is computed from these offers, never supplied
 * by the agent.
 */
import { layoverOffer, nonstopOffer } from '../flights/fixtures.js';
import { stops, usd } from '../flights/rules.js';
import type { FlightOffer } from '../flights/types.js';

/** Nonstop and refundable, but over a $600 budget. */
const premiumNonstop: FlightOffer = {
  offerId: 'offer-premium', carrier: 'Example Air', refundable: true, totalCents: 64900, currency: 'USD',
  outbound: [{ flight: 'EX 900', from: 'JFK', to: 'SFO', departAt: '2026-10-16T08:30:00-04:00', arriveAt: '2026-10-16T11:48:00-07:00' }],
  inbound: [{ flight: 'EX 901', from: 'SFO', to: 'JFK', departAt: '2026-10-18T13:15:00-07:00', arriveAt: '2026-10-18T21:55:00-04:00' }],
};

/** Nonstop and cheap, but the fare is non-refundable. */
const basicNonstop: FlightOffer = {
  offerId: 'offer-basic', carrier: 'Example Air', refundable: false, totalCents: 47900, currency: 'USD',
  outbound: [{ flight: 'EX 415', from: 'JFK', to: 'SFO', departAt: '2026-10-16T15:50:00-04:00', arriveAt: '2026-10-16T19:15:00-07:00' }],
  inbound: [{ flight: 'EX 216', from: 'SFO', to: 'JFK', departAt: '2026-10-18T11:49:00-07:00', arriveAt: '2026-10-18T20:34:00-04:00' }],
};

export const catalog: FlightOffer[] = [nonstopOffer, layoverOffer, premiumNonstop, basicNonstop];

export function findOffer(offerId: string): FlightOffer | undefined {
  return catalog.find(o => o.offerId === offerId);
}

/** What search results show the agent: plain facts about each offer. */
export function describeOffer(o: FlightOffer) {
  return {
    offerId: o.offerId, carrier: o.carrier, price: usd(o.totalCents), stops: stops(o), refundable: o.refundable,
    outbound: o.outbound.map(l => `${l.flight} ${l.from} ${l.departAt} → ${l.to} ${l.arriveAt}`),
    return: o.inbound.map(l => `${l.flight} ${l.from} ${l.departAt} → ${l.to} ${l.arriveAt}`),
  };
}
