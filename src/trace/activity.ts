/**
 * Activity summary for the observability page, built only from recorded
 * traces: which sites the agent visited (and which refused it), every
 * payment it attempted with its current status, and the money that actually
 * moved on Natural. Pure: events in, summary out.
 */
import type { RecordedEvent } from './events.js';

export interface SiteVisit { kind: 'search' | 'page'; target: string; status: 'loaded' | 'blocked' | 'error'; detail: string; at: string }
export type AttemptStatus = 'accepted' | 'rejected' | 'in_review' | 'approved' | 'denied' | 'failed';
export interface PaymentAttempt {
  attemptId: string; offerId: string; label: string; amountCents: number; sourceUrl: string;
  mode: 'blocker' | 'observer'; blockerDecision: 'accepted' | 'rejected' | 'in_review';
  status: AttemptStatus; reasons: string[]; transferId?: string; transferStatus?: string; at: string;
}
export interface RunActivity { traceId: string; sites: SiteVisit[]; attempts: PaymentAttempt[]; moneyMovedCents: number }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function siteStatus(output: string, isError: boolean): { status: SiteVisit['status']; detail: string } {
  const http = /HTTP (\d{3})/.exec(output.slice(0, 200));
  if (http && Number(http[1]) >= 400) return { status: 'blocked', detail: `HTTP ${http[1]}` };
  if (isError) return { status: 'error', detail: output.slice(0, 120) };
  return { status: 'loaded', detail: '' };
}

export function runActivity(events: RecordedEvent[]): RunActivity {
  const traceId = events[0]?.traceId ?? '';
  const calls = new Map<string, { tool: string; input: Record<string, unknown>; at: string }>();
  const sites: SiteVisit[] = [];
  const attempts = new Map<string, PaymentAttempt>();
  let moneyMovedCents = 0;
  for (const e of events) {
    if (e.type === 'agent_tool_call') calls.set(e.data.toolUseId, { tool: e.data.tool, input: obj(e.data.input), at: e.at });
    if (e.type === 'agent_tool_result' && (e.data.tool === 'WebSearch' || e.data.tool === 'WebFetch')) {
      const call = calls.get(e.data.toolUseId);
      const search = e.data.tool === 'WebSearch';
      sites.push({
        kind: search ? 'search' : 'page', target: String(call?.input[search ? 'query' : 'url'] ?? ''),
        ...siteStatus(e.data.output, e.data.isError), at: call?.at ?? e.at,
      });
    }
    if (e.type === 'payment_attempted') {
      const o = e.data.offer;
      attempts.set(e.data.attemptId, {
        attemptId: e.data.attemptId, offerId: o.offerId, label: `${o.carrier} ${o.outbound.map(l => l.flight).join(' + ')}`,
        amountCents: o.totalCents, sourceUrl: e.data.sourceUrl, mode: e.data.mode, blockerDecision: e.data.blockerDecision,
        status: e.data.decision, reasons: e.data.reasons, at: e.at,
      });
    }
    if (e.type === 'payment_reviewed') {
      const a = attempts.get(e.data.attemptId);
      if (a) a.status = e.data.decision;
    }
    if (e.type === 'money_moved') {
      const a = attempts.get(e.data.attemptId);
      if (a) {
        a.transferId = e.data.transferId;
        a.transferStatus = e.data.status;
        if (e.data.status !== 'COMPLETED') a.status = 'failed';
      }
      if (e.data.status === 'COMPLETED') moneyMovedCents += e.data.amountCents;
    }
  }
  return { traceId, sites, attempts: [...attempts.values()], moneyMovedCents };
}

export interface Overview {
  runs: number; sitesVisited: number; sitesBlocked: number; moneyMovedCents: number;
  attempts: Record<AttemptStatus, number> & { total: number };
}

export function overview(traces: RecordedEvent[][]): Overview {
  const out: Overview = { runs: 0, sitesVisited: 0, sitesBlocked: 0, moneyMovedCents: 0, attempts: { total: 0, accepted: 0, rejected: 0, in_review: 0, approved: 0, denied: 0, failed: 0 } };
  for (const events of traces) {
    if (!events.some(e => e.type === 'agent_run_started')) continue;
    const a = runActivity(events);
    out.runs += 1;
    out.sitesVisited += a.sites.length;
    out.sitesBlocked += a.sites.filter(s => s.status === 'blocked').length;
    out.moneyMovedCents += a.moneyMovedCents;
    for (const p of a.attempts) { out.attempts.total += 1; out.attempts[p.status] += 1; }
  }
  return out;
}
