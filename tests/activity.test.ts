import { describe, expect, it } from 'vitest';
import type { FlightOffer } from '../src/flights/types.js';
import { overview, runActivity } from '../src/trace/activity.js';
import type { RecordedEvent, TraceEvent } from '../src/trace/events.js';

let seq = 0;
const ev = (traceId: string, e: TraceEvent): RecordedEvent => ({ ...e, traceId, seq: ++seq, at: '2026-09-30T08:00:00.000Z' }) as RecordedEvent;
const offer: FlightOffer = {
  offerId: 'web-1', carrier: 'JetBlue', refundable: false, totalCents: 56800, currency: 'USD',
  outbound: [{ flight: 'B6 115', from: 'JFK', to: 'SFO', departAt: '2026-10-16T06:00', arriveAt: '2026-10-16T09:15' }],
  inbound: [{ flight: 'B6 216', from: 'SFO', to: 'JFK', departAt: '2026-10-18T11:49', arriveAt: '2026-10-18T20:34' }],
};
const visit = (t: string, id: string, tool: 'WebSearch' | 'WebFetch', input: Record<string, string>, output: string) => [
  ev(t, { type: 'agent_tool_call', data: { toolUseId: id, tool, input } }),
  ev(t, { type: 'agent_tool_result', data: { toolUseId: id, tool, output, isError: false } }),
];
const run = (t: string, decision: 'accepted' | 'in_review') => [
  ev(t, { type: 'agent_run_started', data: { agentVersionId: 'v', profile: 'careful-web', model: 'sonnet', prompt: 'p', refusalFeedback: 'explain' } }),
  ...visit(t, 'a', 'WebSearch', { query: 'JFK SFO nonstop' }, 'results...'),
  ...visit(t, 'b', 'WebFetch', { url: 'https://www.jetblue.com/x' }, 'JFK-SFO from $234'),
  ...visit(t, 'c', 'WebFetch', { url: 'https://www.expedia.com/y' }, 'The server returned HTTP 429 Too Many Requests.'),
  ev(t, { type: 'payment_attempted', data: { attemptId: `${t}:web-1`, label: 'JetBlue B6 115', amountCents: 56800, offer, sourceUrl: 'https://www.jetblue.com/x', mode: 'blocker', decision, blockerDecision: decision, reasons: [] } }),
];

describe('activity', () => {
  it('lists sites visited, marking the ones that refused the agent', () => {
    expect(runActivity(run('t1', 'accepted')).sites.map(s => [s.kind, s.target, s.status, s.detail])).toEqual([
      ['search', 'JFK SFO nonstop', 'loaded', ''],
      ['page', 'https://www.jetblue.com/x', 'loaded', ''],
      ['page', 'https://www.expedia.com/y', 'blocked', 'HTTP 429'],
    ]);
  });

  it("tracks each payment's latest status and counts only money that completed on Natural", () => {
    const paid = [...run('t1', 'accepted'), ev('t1', { type: 'money_moved', data: { attemptId: 't1:web-1', transferId: 'trf_1', amountCents: 56800, from: 'Travel budget', to: 'Example Air (merchant)', status: 'COMPLETED' } })];
    const held = run('t2', 'in_review');
    const denied = [...run('t3', 'in_review'), ev('t3', { type: 'payment_reviewed', data: { attemptId: 't3:web-1', decision: 'denied', by: 'customer' } })];
    expect(runActivity(paid)).toMatchObject({ moneyMovedCents: 56800, attempts: [{ status: 'accepted', transferId: 'trf_1', label: 'JetBlue B6 115' }] });
    expect(overview([paid, held, denied])).toEqual({
      runs: 3, sitesVisited: 9, sitesBlocked: 3, moneyMovedCents: 56800,
      attempts: { total: 3, accepted: 1, rejected: 0, in_review: 1, approved: 0, denied: 1, failed: 0 },
    });
  });
});
