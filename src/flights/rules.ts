import type { FlightOffer, FlightRequirements } from './types.js';

export interface Violation { rule: keyof FlightRequirements; detail: string }
export interface RequirementDifference { field: keyof FlightRequirements; confirmed: unknown; interpreted: unknown }

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const localDate = (iso: string): string => iso.slice(0, 10);

/** Connections in the longer direction. 0 means nonstop both ways. */
export function stops(offer: FlightOffer): number {
  return Math.max(offer.outbound.length, offer.inbound.length) - 1;
}

/** What the payment is for, readable on Natural's dashboard (80-character limit). */
export function paymentDescription(offer: FlightOffer): string {
  const first = offer.outbound[0], back = offer.inbound[0];
  const day = (iso: string) => new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const route = first && back ? `${first.from}-${offer.outbound.at(-1)?.to ?? first.to} ${day(first.departAt)} to ${day(back.departAt)}` : offer.offerId;
  const n = stops(offer);
  return `${offer.carrier} ${route}, ${n === 0 ? 'nonstop' : `${n} stop`}, ${offer.refundable ? 'refundable' : 'non-refundable'}`.slice(0, 80);
}

/** Every requirement the offer breaks, in a fixed order. Empty means it fits. */
export function checkOffer(req: FlightRequirements, offer: FlightOffer): Violation[] {
  const out = offer.outbound, back = offer.inbound;
  const firstOut = out[0], lastOut = out[out.length - 1], firstBack = back[0], lastBack = back[back.length - 1];
  if (!firstOut || !lastOut || !firstBack || !lastBack) return [{ rule: 'from', detail: 'offer is missing its outbound or return flight' }];
  const v: Violation[] = [];
  if (firstOut.from !== req.from || lastOut.to !== req.to) v.push({ rule: 'to', detail: `goes ${firstOut.from}→${lastOut.to}, not ${req.from}→${req.to}` });
  if (firstBack.from !== req.to || lastBack.to !== req.from) v.push({ rule: 'from', detail: `returns ${firstBack.from}→${lastBack.to}, not ${req.to}→${req.from}` });
  if (localDate(firstOut.departAt) !== req.departOn) v.push({ rule: 'departOn', detail: `departs ${localDate(firstOut.departAt)}, not ${req.departOn}` });
  if (localDate(firstBack.departAt) !== req.returnOn) v.push({ rule: 'returnOn', detail: `returns ${localDate(firstBack.departAt)}, not ${req.returnOn}` });
  if (req.directOnly && stops(offer) > 0) v.push({ rule: 'directOnly', detail: `has ${stops(offer)} stop(s); direct only was required` });
  if (req.refundableOnly && !offer.refundable) v.push({ rule: 'refundableOnly', detail: 'fare is non-refundable; refundable was required' });
  if (offer.totalCents > req.maxTotalCents) v.push({ rule: 'maxTotalCents', detail: `costs ${usd(offer.totalCents)}, over the ${usd(req.maxTotalCents)} limit` });
  return v;
}

const FIELDS: (keyof FlightRequirements)[] = ['from', 'to', 'departOn', 'returnOn', 'directOnly', 'refundableOnly', 'maxTotalCents'];

/** Where the agent's understanding differs from what the person confirmed. */
export function diffRequirements(confirmed: FlightRequirements, interpreted: FlightRequirements): RequirementDifference[] {
  return FIELDS.filter(f => confirmed[f] !== interpreted[f])
    .map(field => ({ field, confirmed: confirmed[field], interpreted: interpreted[field] }));
}
