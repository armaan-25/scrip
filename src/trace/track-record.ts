/**
 * Per-agent-version track record, built only from recorded traces: how often
 * the version understood the request, which requirements it misread, and how
 * its purchases ended. This is "did it do what it was told", not a log.
 */
import type { RecordedEvent } from './events.js';
import { type AlertKind, monitorAlerts } from './monitors.js';

export interface VersionRecord {
  versionId: string;
  profile: string;
  runs: number;
  stated: number;
  understoodCorrectly: number;
  misread: Record<string, number>;
  paid: number;
  /** Purchase requests Scrip refused, counting retries within a run. */
  blockedBeforePayment: number;
  deniedAtPayment: number;
  toolCalls: number;
  /** Web flights whose cited page Scrip opened, and how many showed the claimed price and flights. */
  sourceChecks: number;
  sourceBacked: number;
  /** Monitor alerts raised across this version's runs, by kind. */
  alerts: Partial<Record<AlertKind, number>>;
  costUsd: number;
}

export function trackRecords(traces: RecordedEvent[][]): VersionRecord[] {
  const byVersion = new Map<string, VersionRecord>();
  for (const events of traces) {
    const start = events.find(e => e.type === 'agent_run_started');
    const interp = events.find(e => e.type === 'agent_interpretation_recorded');
    const versionId = start?.type === 'agent_run_started' ? start.data.agentVersionId : interp?.type === 'agent_interpretation_recorded' ? interp.data.agentVersionId : undefined;
    if (!versionId) continue;
    const profile = start?.type === 'agent_run_started' ? start.data.profile : 'scripted';
    const r = byVersion.get(versionId) ?? { versionId, profile, runs: 0, stated: 0, understoodCorrectly: 0, misread: {}, paid: 0, blockedBeforePayment: 0, deniedAtPayment: 0, toolCalls: 0, sourceChecks: 0, sourceBacked: 0, alerts: {}, costUsd: 0 };
    r.runs += 1;
    for (const a of monitorAlerts(events)) r.alerts[a.kind] = (r.alerts[a.kind] ?? 0) + 1;
    for (const e of events) {
      if (e.type === 'interpretation_compared') {
        r.stated += 1;
        if (e.data.differences.length === 0) r.understoodCorrectly += 1;
        for (const d of e.data.differences) r.misread[d.field] = (r.misread[d.field] ?? 0) + 1;
      }
      if (e.type === 'agent_tool_call') r.toolCalls += 1;
      if (e.type === 'purchase_refused') r.blockedBeforePayment += 1;
      if (e.type === 'source_checked' && e.data.status !== 'unreadable') { r.sourceChecks += 1; if (e.data.status === 'backed') r.sourceBacked += 1; }
      if (e.type === 'agent_run_finished' && e.data.costUsd !== null) r.costUsd = Math.round((r.costUsd + e.data.costUsd) * 1000) / 1000;
    }
    if (events.some(e => e.type === 'payment_settled' && e.data.status === 'COMPLETED')) r.paid += 1;
    if (events.some(e => e.type === 'hold_decided' && e.data.decision === 'denied')) r.deniedAtPayment += 1;
    byVersion.set(versionId, r);
  }
  return [...byVersion.values()];
}
