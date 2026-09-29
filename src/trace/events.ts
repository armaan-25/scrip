import type { RequirementDifference, Violation } from '../flights/rules.js';
import type { FlightOffer, FlightRequirements } from '../flights/types.js';

/** Everything that can happen to one purchase, in the order it happens. */
export type TraceEvent =
  | { type: 'request_received'; data: { consumerId: string; words: string } }
  | { type: 'requirements_confirmed'; data: { requirements: FlightRequirements; requirementsDigest: string } }
  | { type: 'agent_interpretation_recorded'; data: { agentVersionId: string; interpretation: FlightRequirements } }
  | { type: 'interpretation_compared'; data: { differences: RequirementDifference[] } }
  | { type: 'candidate_checked'; data: { offer: FlightOffer; violations: Violation[] } }
  | { type: 'purchase_refused'; data: { reasons: string[] } }
  | { type: 'purchase_approved'; data: { offer: FlightOffer; fingerprint: string; totalCents: number; naturalAgentId: string; authorizationId: string; reservationId: string } }
  | { type: 'payment_submitted'; data: { paymentId: string; instanceId: string; fingerprintTag: string; amountCents: number } }
  | { type: 'payment_held'; data: { approvalId: string; paymentId: string; reasons: string[]; senderAgentId: string | null } }
  | { type: 'hold_decision_started'; data: { approvalId: string; paymentId: string; decision: 'approved' | 'denied' } }
  | { type: 'hold_decided'; data: { approvalId: string; paymentId: string; decision: 'approved' | 'denied'; reasons: string[] } }
  | { type: 'payment_settled'; data: { paymentId: string; status: string; note?: string } };

export type RecordedEvent = TraceEvent & { traceId: string; seq: number; at: string };
