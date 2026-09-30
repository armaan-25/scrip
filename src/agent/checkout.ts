/**
 * What Scrip does with an agent's checkout. Pure: the confirmed request, the
 * flight the agent submitted, and everything it read before submitting go
 * in; a decision comes out.
 *
 *   rejected   the flight breaks what the person confirmed
 *   in_review  the claimed price or flight numbers never appeared in the
 *              agent's own research, so a person should look first
 *   accepted   otherwise
 *
 * Blocker mode acts on that decision. Observer mode always accepts and
 * records what Blocker would have done.
 */
import { checkOffer, type Violation } from '../flights/rules.js';
import type { FlightOffer, FlightRequirements } from '../flights/types.js';
import { findClaims } from './source-check.js';

export type ScripMode = 'blocker' | 'observer';
export type CheckoutDecision = 'accepted' | 'rejected' | 'in_review';
export interface CheckoutVerdict {
  decision: CheckoutDecision;
  /** What Blocker mode decides; equals decision in Blocker mode. */
  blockerDecision: CheckoutDecision;
  reasons: string[];
  violations: Violation[];
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function decideCheckout(requirements: FlightRequirements, offer: FlightOffer, research: string, mode: ScripMode): CheckoutVerdict {
  const violations = checkOffer(requirements, offer);
  let blockerDecision: CheckoutDecision;
  let reasons: string[];
  if (violations.length) {
    blockerDecision = 'rejected';
    reasons = violations.map(v => v.detail);
  } else {
    const found = findClaims(research, offer);
    const unseen = [...(found.priceShown ? [] : [`price ${usd(offer.totalCents)}`]), ...found.flightsMissing];
    blockerDecision = unseen.length ? 'in_review' : 'accepted';
    reasons = unseen.length ? [`not found in anything the agent read: ${unseen.join(', ')}`] : [];
  }
  return { decision: mode === 'blocker' ? blockerDecision : 'accepted', blockerDecision, reasons, violations };
}
