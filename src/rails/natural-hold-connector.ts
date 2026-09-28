/**
 * Watches Natural for held payments that Scrip owns (tagged scrip_trace_id)
 * and releases each only if it matches the approved purchase. Untagged holds
 * are left for a human. On any Natural error nothing is recorded, so the next
 * poll retries; it never approves on error.
 */
import type { FlightTraceService } from '../trace/trace-service.js';
import { decideHold } from './hold-decision.js';
import type { NaturalPort } from './natural-port.js';

export interface PollResult { approved: string[]; denied: string[]; skipped: string[]; errors: string[] }

export class NaturalHoldConnector {
  constructor(private owner: NaturalPort, private traces: FlightTraceService) {}

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { approved: [], denied: [], skipped: [], errors: [] };
    for (const held of await this.owner.listPendingHolds()) {
      const traceId = held.tags.scrip_trace_id;
      if (!traceId) { result.skipped.push(held.approvalId); continue; }

      if (!this.traces.exists(traceId)) {
        try { await this.owner.denyHold(held.approvalId, 'no purchase was approved for this trace'); result.denied.push(held.approvalId); }
        catch (error) { result.errors.push(`${held.approvalId}: ${(error as Error).message}`); }
        continue;
      }
      if (this.traces.isHoldDecided(traceId, held.approvalId)) continue;
      if (!this.traces.isHoldRecorded(traceId, held.approvalId)) {
        this.traces.recordHold(traceId, { approvalId: held.approvalId, paymentId: held.paymentId, reasons: held.reasons, senderAgentId: held.senderAgentId });
      }

      const decision = decideHold(this.traces.approvedPurchase(traceId), held, this.traces.hasApprovedPayment(traceId));
      try {
        if (decision.approve) await this.owner.approveHold(held.approvalId);
        else await this.owner.denyHold(held.approvalId, decision.reasons.join('; '));
      } catch (error) {
        result.errors.push(`${held.approvalId}: ${(error as Error).message}`);
        continue;
      }
      this.traces.recordDecision(traceId, { approvalId: held.approvalId, paymentId: held.paymentId, decision: decision.approve ? 'approved' : 'denied', reasons: decision.reasons });
      (decision.approve ? result.approved : result.denied).push(held.approvalId);
    }
    return result;
  }
}
