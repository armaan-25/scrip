import { describe, expect, it } from 'vitest';
import type { RecordedEvent, TraceEvent } from '../src/trace/events.js';
import { trackRecords } from '../src/trace/track-record.js';

let seq = 0;
const ev = (traceId: string, e: TraceEvent): RecordedEvent => ({ ...e, traceId, seq: ++seq, at: '2026-09-29T12:00:00.000Z' }) as RecordedEvent;
const started = (t: string, v: string, profile: string): RecordedEvent => ev(t, { type: 'agent_run_started', data: { agentVersionId: v, profile, model: 'sonnet', prompt: 'p' } });
const diff = (t: string, fields: string[]): RecordedEvent => ev(t, { type: 'interpretation_compared', data: { differences: fields.map(f => ({ field: f as 'directOnly', confirmed: true, interpreted: false })) } });

describe('trackRecords', () => {
  it('summarizes each agent version: understood, misread fields, outcomes, tool calls, cost', () => {
    const traces: RecordedEvent[][] = [
      [started('a', 'v1', 'careful'), diff('a', []), ev('a', { type: 'agent_tool_call', data: { toolUseId: '1', tool: 'search_flights', input: {} } }),
        ev('a', { type: 'hold_decided', data: { approvalId: 'x', paymentId: 'p', decision: 'approved', reasons: [] } }),
        ev('a', { type: 'payment_settled', data: { paymentId: 'p', status: 'COMPLETED' } }),
        ev('a', { type: 'agent_run_finished', data: { ok: true, turns: 6, costUsd: 0.1, summary: '' } })],
      [started('b', 'v2', 'bargain'), diff('b', ['directOnly', 'refundableOnly']), ev('b', { type: 'purchase_refused', data: { reasons: ['directOnly'] } }),
        ev('b', { type: 'agent_run_finished', data: { ok: true, turns: 5, costUsd: 0.2, summary: '' } })],
      [started('c', 'v2', 'bargain'), diff('c', ['directOnly']),
        ev('c', { type: 'hold_decided', data: { approvalId: 'y', paymentId: 'q', decision: 'denied', reasons: ['mismatch'] } }),
        ev('c', { type: 'agent_run_finished', data: { ok: true, turns: 7, costUsd: 0.3, summary: '' } })],
    ];
    const records = trackRecords(traces);
    expect(records).toEqual([
      { versionId: 'v1', profile: 'careful', runs: 1, understoodCorrectly: 1, stated: 1, misread: {}, paid: 1, blockedBeforePayment: 0, deniedAtPayment: 0, toolCalls: 1, sourceChecks: 0, sourceBacked: 0, costUsd: 0.1 },
      { versionId: 'v2', profile: 'bargain', runs: 2, understoodCorrectly: 0, stated: 2, misread: { directOnly: 2, refundableOnly: 1 }, paid: 0, blockedBeforePayment: 1, deniedAtPayment: 1, toolCalls: 0, sourceChecks: 0, sourceBacked: 0, costUsd: 0.5 },
    ]);
  });

  it('counts a refused purchase even when the agent retries and then pays', () => {
    const [record] = trackRecords([[started('d', 'v3', 'bargain'),
      ev('d', { type: 'purchase_refused', data: { reasons: ['directOnly'] } }),
      ev('d', { type: 'payment_settled', data: { paymentId: 'p', status: 'COMPLETED' } })]]);
    expect(record).toMatchObject({ blockedBeforePayment: 1, paid: 1 });
  });
});
