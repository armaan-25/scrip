import type { RequirementDifference, Violation } from '../flights/rules.js';
import type { FlightOffer, FlightRequirements } from '../flights/types.js';
import type { CanonicalOrder, MerchantReply, OrderComparison } from '../merchant/accept-merchant.js';
import type { MustCheck, PurchaseItem } from '../purchase/purchase.js';

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
  | { type: 'source_checked'; data: { offerId: string; url: string; status: 'backed' | 'not_backed' | 'unreadable'; priceShown: boolean; flightsShown: string[]; flightsMissing: string[]; detail: string } }
  | { type: 'task_confirmed'; data: { budgetCents: number; musts: string[] } }
  | { type: 'purchase_understanding'; data: { budgetCents: number; musts: string[] } }
  | { type: 'purchase_checked'; data: { attemptId: string; item: PurchaseItem; priceSeen: boolean; pageSeen: boolean; pageOpened?: boolean; priceOnPage?: boolean; checks: MustCheck[]; checkerModel: string; checkerError?: string } }
  | { type: 'merchant_order'; data: { attemptId: string; approved: CanonicalOrder | null; reply: MerchantReply; comparison?: OrderComparison } }
  | { type: 'payment_attempted'; data: { attemptId: string; label: string; amountCents: number; offer?: FlightOffer; item?: PurchaseItem; sourceUrl: string; mode: 'blocker' | 'observer'; decision: 'accepted' | 'rejected' | 'in_review'; blockerDecision: 'accepted' | 'rejected' | 'in_review'; reasons: string[] } }
  | { type: 'payment_reviewed'; data: { attemptId: string; decision: 'approved' | 'denied'; by: string } }
  | { type: 'money_moved'; data: { attemptId: string; transferId: string; amountCents: number; from: string; to: string; status: string } }
  | { type: 'agent_run_started'; data: { agentVersionId: string; profile: string; model: string; prompt: string; refusalFeedback: 'explain' | 'ask_customer' } }
  | { type: 'agent_tool_call'; data: { toolUseId: string; tool: string; input: unknown } }
  | { type: 'agent_tool_result'; data: { toolUseId: string; tool: string; output: string; isError: boolean } }
  | { type: 'agent_message'; data: { text: string } }
  | { type: 'agent_run_finished'; data: { ok: boolean; turns: number | null; costUsd: number | null; summary: string } };

/** Events that record what a real agent did (its tool calls and messages). */
export type AgentTraceEvent = Extract<TraceEvent, { type: 'agent_run_started' | 'agent_tool_call' | 'agent_tool_result' | 'agent_message' | 'agent_run_finished' }>;

export type RecordedEvent = TraceEvent & { traceId: string; seq: number; at: string };
