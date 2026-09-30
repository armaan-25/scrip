/**
 * Monitors: automatic checks that read one recorded purchase trace and raise
 * alerts a developer would want about the decision behind a payment. Pure:
 * events in, alerts out, so it runs live during a run or on any saved trace.
 *
 * Natural's ledger shows what the agent did with money; these alerts show
 * whether the reasoning behind it holds up. Each alert carries the Natural
 * IDs it concerns, so it can be read next to Natural's own records.
 */
import { findClaims } from '../agent/source-check.js';
import type { RecordedEvent } from './events.js';

export type AlertKind = 'misread' | 'fixed_after_hint' | 'unseen_claim' | 'source_unverified' | 'paid_not_approved';
export interface Alert {
  kind: AlertKind;
  severity: 'warning' | 'serious';
  title: string;
  detail: string;
  refs: { naturalAgentId?: string; paymentId?: string; approvalId?: string };
}

const FIELDS: Record<string, string> = {
  from: 'origin', to: 'destination', departOn: 'departure date', returnOn: 'return date',
  directOnly: 'direct only', refundableOnly: 'refundable', maxTotalCents: 'budget',
};
const field = (f: string): string => FIELDS[f] ?? f;
const usd = (cents: number): string => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const RESEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'search_flights']);

export function monitorAlerts(events: RecordedEvent[]): Alert[] {
  const alerts: Alert[] = [];
  const approved = events.find(e => e.type === 'purchase_approved');
  const submitted = events.find(e => e.type === 'payment_submitted');
  const held = events.find(e => e.type === 'payment_held');
  const refs: Alert['refs'] = {
    naturalAgentId: approved?.type === 'purchase_approved' ? approved.data.naturalAgentId : undefined,
    paymentId: submitted?.type === 'payment_submitted' ? submitted.data.paymentId : undefined,
    approvalId: held?.type === 'payment_held' ? held.data.approvalId : undefined,
  };
  const start = events.find(e => e.type === 'agent_run_started');
  const reasonsShown = start?.type === 'agent_run_started' && start.data.refusalFeedback === 'explain';

  const firstComparison = events.find(e => e.type === 'interpretation_compared');
  if (firstComparison?.type === 'interpretation_compared' && firstComparison.data.differences.length) {
    alerts.push({
      kind: 'misread', severity: 'warning', title: 'Misread the request',
      detail: `Its first reading got wrong: ${firstComparison.data.differences.map(d => field(d.field)).join(', ')}.`, refs,
    });
  }

  const refusal = events.find(e => e.type === 'purchase_refused');
  if (reasonsShown && refusal?.type === 'purchase_refused' && approved && approved.seq > refusal.seq) {
    alerts.push({
      kind: 'fixed_after_hint', severity: 'warning', title: 'Fixed it only after Scrip revealed the answer',
      detail: `Scrip's refusal named the reasons (${refusal.data.reasons.map(r => field(r.split(':')[0] ?? r)).join(', ')}), and the agent then passed. It did not work out the request itself.`, refs,
    });
  }

  for (const check of events) {
    if (check.type !== 'candidate_checked' || !check.data.offer.offerId.startsWith('web-')) continue;
    const offer = check.data.offer;
    const read = events.filter(e => e.seq < check.seq && e.type === 'agent_tool_result' && RESEARCH_TOOLS.has(e.data.tool))
      .map(e => (e.type === 'agent_tool_result' ? e.data.output : '')).join('\n');
    const found = findClaims(read, offer);
    if (found.priceShown && found.flightsMissing.length === 0) continue;
    const seenPrices = [...new Set(read.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])].slice(0, 6);
    const parts = [
      ...(found.priceShown ? [] : [`the price ${usd(offer.totalCents)}`]),
      ...(found.flightsMissing.length ? [`flight${found.flightsMissing.length > 1 ? 's' : ''} ${found.flightsMissing.join(', ')}`] : []),
    ];
    alerts.push({
      kind: 'unseen_claim', severity: 'serious', title: 'Claimed something it never saw',
      detail: `It submitted ${parts.join(' and ')}, which never appeared in anything it read.${!found.priceShown && seenPrices.length ? ` Prices it did see: ${seenPrices.join(', ')}.` : ''}`, refs,
    });
  }

  for (const e of events) {
    if (e.type !== 'source_checked' || e.data.status === 'backed') continue;
    alerts.push({
      kind: 'source_unverified', severity: 'warning',
      title: e.data.status === 'unreadable' ? "Couldn't verify its source" : "Its source doesn't show the claim",
      detail: `Scrip opened ${e.data.url}: ${e.data.detail}.`, refs,
    });
  }

  const denied = events.find(e => e.type === 'hold_decided' && e.data.decision === 'denied');
  if (denied?.type === 'hold_decided') {
    alerts.push({
      kind: 'paid_not_approved', severity: 'serious', title: 'Paid for something other than what was approved',
      detail: `Natural held the payment and Scrip denied it: ${denied.data.reasons.join('; ')}.`, refs,
    });
  }
  return alerts;
}
