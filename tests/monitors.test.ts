import { describe, expect, it } from 'vitest';
import type { FlightOffer } from '../src/flights/types.js';
import type { RecordedEvent, TraceEvent } from '../src/trace/events.js';
import { monitorAlerts } from '../src/trace/monitors.js';

let seq = 0;
const ev = (e: TraceEvent): RecordedEvent => ({ ...e, traceId: 't', seq: ++seq, at: '2026-09-30T06:00:00.000Z' }) as RecordedEvent;
const started = (refusalFeedback: 'explain' | 'ask_customer' = 'explain') =>
  ev({ type: 'agent_run_started', data: { agentVersionId: 'v1', profile: 'careful-web', model: 'sonnet', prompt: 'p', refusalFeedback } });
const read = (tool: string, output: string) => ev({ type: 'agent_tool_result', data: { toolUseId: String(seq), tool, output, isError: false } });
const webOffer: FlightOffer = {
  offerId: 'web-1', carrier: 'JetBlue', refundable: false, totalCents: 55300, currency: 'USD',
  outbound: [{ flight: 'B6 615', from: 'JFK', to: 'SFO', departAt: '2026-10-16T17:59', arriveAt: '2026-10-16T21:26' }],
  inbound: [{ flight: 'B6 416', from: 'SFO', to: 'JFK', departAt: '2026-10-18T08:15', arriveAt: '2026-10-18T16:49' }],
};
const checked = (offer: FlightOffer) => ev({ type: 'candidate_checked', data: { offer, violations: [] } });
const kinds = (events: RecordedEvent[]) => monitorAlerts(events).map(a => a.kind);

describe('monitors', () => {
  it("flags the real $553 run: a price and flights that never appeared in the agent's research", () => {
    const alerts = monitorAlerts([
      started(),
      read('WebFetch', 'October 16, 2026 (JFK to SFO): a fare of **$234**. October 18, 2026: a fare of **$319**. Does not specify flight numbers.'),
      read('WebSearch', 'B615 - JetBlue B6 15 Flight Tracker ...'),
      checked(webOffer),
      ev({ type: 'source_checked', data: { offerId: 'web-1', url: 'https://www.jetblue.com/x', status: 'unreadable', priceShown: false, flightsShown: [], flightsMissing: [], detail: 'the site refused (HTTP 406)' } }),
    ]);
    expect(alerts.map(a => a.kind)).toEqual(['unseen_claim', 'source_unverified']);
    expect(alerts[0]?.detail).toBe('It submitted the price $553 and flights B6 615, B6 416, which never appeared in anything it read. Prices it did see: $234, $319.');
  });

  it('raises nothing when the claimed price and flights were in what the agent read', () => {
    expect(kinds([started(), read('WebFetch', 'JetBlue B6 615 out, B6 416 back, round trip $553.00'), checked(webOffer)])).toEqual([]);
  });

  it('flags a misread, and a fix that only came after refusal reasons were shown', () => {
    const run = (feedback: 'explain' | 'ask_customer') => kinds([
      started(feedback),
      ev({ type: 'interpretation_compared', data: { differences: [{ field: 'directOnly', confirmed: true, interpreted: false }] } }),
      ev({ type: 'purchase_refused', data: { reasons: ['directOnly: has 1 stop(s); direct only was required'] } }),
      ev({ type: 'purchase_approved', data: { offer: webOffer, fingerprint: 'sha256:x', totalCents: 55300, naturalAgentId: 'agt_1', authorizationId: 'a', reservationId: 'r' } }),
    ]);
    expect(run('explain')).toEqual(['misread', 'fixed_after_hint']);
    expect(run('ask_customer')).toEqual(['misread']);
  });

  it("flags a payment Natural held and Scrip denied, with Natural's ids attached", () => {
    const [alert] = monitorAlerts([
      ev({ type: 'payment_submitted', data: { paymentId: 'pay_1', instanceId: 't', fingerprintTag: 'sha256:y', amountCents: 38900 } }),
      ev({ type: 'payment_held', data: { approvalId: 'apr_1', paymentId: 'pay_1', reasons: [], senderAgentId: 'agt_1' } }),
      ev({ type: 'hold_decided', data: { approvalId: 'apr_1', paymentId: 'pay_1', decision: 'denied', reasons: ['paid-for order does not match'] } }),
    ]);
    expect(alert).toMatchObject({ kind: 'paid_not_approved', severity: 'serious', refs: { paymentId: 'pay_1', approvalId: 'apr_1' } });
  });
});
