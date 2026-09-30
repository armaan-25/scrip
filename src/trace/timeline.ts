import { usd } from '../flights/rules.js';
import type { RecordedEvent } from './events.js';

const short = (fp: string): string => fp.replace('sha256:', '').slice(0, 12);

/** One plain-English line per recorded step. */
export function renderTimeline(events: RecordedEvent[]): string[] {
  return events.map(e => {
    switch (e.type) {
      case 'request_received': return `Person asked: "${e.data.words}"`;
      case 'requirements_confirmed': {
        const r = e.data.requirements;
        return `Person confirmed: ${r.from}→${r.to} ${r.departOn}–${r.returnOn}, ${r.directOnly ? 'direct only' : 'stops ok'}, ${r.refundableOnly ? 'refundable only' : 'any fare'}, max ${usd(r.maxTotalCents)}`;
      }
      case 'agent_interpretation_recorded': return `Agent (version ${e.data.agentVersionId.slice(0, 8)}) stated its understanding of the goal`;
      case 'interpretation_compared': return e.data.differences.length
        ? `MISUNDERSTOOD: ${e.data.differences.map(d => `${d.field} (asked ${String(d.confirmed)}, agent thought ${String(d.interpreted)})`).join('; ')}`
        : 'Agent understood the goal exactly as confirmed';
      case 'candidate_checked': return e.data.violations.length
        ? `Agent chose ${e.data.offer.offerId}: breaks ${e.data.violations.map(v => v.detail).join('; ')}`
        : `Agent chose ${e.data.offer.offerId}: meets every requirement`;
      case 'purchase_refused': return `BLOCKED before payment: ${e.data.reasons.join('; ')}`;
      case 'purchase_approved': return `Purchase approved: ${e.data.offer.offerId}, ${usd(e.data.totalCents)}, fingerprint ${short(e.data.fingerprint)}`;
      case 'payment_submitted': return `Agent paid ${usd(e.data.amountCents)} on Natural (${e.data.paymentId}), tagged fingerprint ${short(e.data.fingerprintTag)}`;
      case 'payment_held': return `Natural held the payment (${e.data.approvalId}) until checked`;
      case 'hold_decision_started': return `Connector: sending ${e.data.decision === 'approved' ? 'approval' : 'denial'} to Natural for ${e.data.approvalId}`;
      case 'hold_decided': return e.data.decision === 'approved'
        ? 'Connector: fingerprint matches the approved purchase → APPROVED'
        : `Connector: DENIED → ${e.data.reasons.join('; ')}`;
      case 'agent_run_started': return `Real agent started: ${e.data.profile} (model ${e.data.model}, version ${e.data.agentVersionId.slice(0, 8)})`;
      case 'agent_tool_call': return `Agent called ${e.data.tool}(${JSON.stringify(e.data.input).slice(0, 160)})`;
      case 'agent_tool_result': return `${e.data.isError ? 'Tool error' : 'Tool result'} from ${e.data.tool}: ${e.data.output.slice(0, 200)}`;
      case 'agent_message': return `Agent said: ${e.data.text.slice(0, 300)}`;
      case 'agent_run_finished': return `Agent finished${e.data.turns !== null ? ` in ${e.data.turns} turns` : ''}${e.data.costUsd !== null ? `, $${e.data.costUsd.toFixed(3)} of model usage` : ''}${e.data.ok ? '' : ' (with an error)'}`;
      case 'payment_settled': return `Final Natural status: ${e.data.status}${e.data.note ? ` (${e.data.note})` : ''}`;
    }
  });
}
