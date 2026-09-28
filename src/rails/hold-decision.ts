import { usd } from '../flights/rules.js';
import type { ApprovedPurchase } from '../trace/trace-service.js';
import type { HeldPayment } from './natural-port.js';

const short = (fp: string | undefined): string => (fp ?? 'none').replace('sha256:', '').slice(0, 12);

/** Approve only an exact match on the paid-for order, amount, and paying agent. Pure. */
export function decideHold(approved: ApprovedPurchase | undefined, held: HeldPayment, alreadyPaid: boolean): { approve: boolean; reasons: string[] } {
  if (!approved) return { approve: false, reasons: ['no purchase was approved for this trace'] };
  const reasons: string[] = [];
  if (alreadyPaid) reasons.push('this purchase has already been paid');
  const tag = held.tags.scrip_order_fp;
  if (tag !== approved.fingerprint) reasons.push(`paid-for order ${short(tag)} does not match approved purchase ${short(approved.fingerprint)}`);
  if (held.amountCents !== approved.totalCents) reasons.push(`amount ${usd(held.amountCents)} does not match approved ${usd(approved.totalCents)}`);
  if (held.senderAgentId !== approved.naturalAgentId) reasons.push(`paid by ${held.senderAgentId ?? 'no agent'}, approved for ${approved.naturalAgentId}`);
  return { approve: reasons.length === 0, reasons };
}
