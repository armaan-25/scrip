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
  | { type: 'payment_settled'; data: { paymentId: string; status: string; note?: string } }
  | { type: 'agent_run_started'; data: { agentVersionId: string; profile: string; model: string; prompt: string } }
  | { type: 'agent_tool_call'; data: { toolUseId: string; tool: string; input: unknown } }
  | { type: 'agent_tool_result'; data: { toolUseId: string; tool: string; output: string; isError: boolean } }
  | { type: 'agent_message'; data: { text: string } }
  | { type: 'agent_run_finished'; data: { ok: boolean; turns: number | null; costUsd: number | null; summary: string } };

/** Events that record what a real agent did (its tool calls and messages). */
export type AgentTraceEvent = Extract<TraceEvent, { type: 'agent_run_started' | 'agent_tool_call' | 'agent_tool_result' | 'agent_message' | 'agent_run_finished' }>;

export type RecordedEvent = TraceEvent & { traceId: string; seq: number; at: string };
