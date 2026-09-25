import type { OutcomeEvidence, TaskReceipt } from '../store.js';

export type OutcomeConstraint =
  | { type: 'amount_at_most'; amount: number }
  | { type: 'merchant_in'; merchants: string[] }
  | { type: 'date_range'; startsOn: string; endsOn: string }
  | { type: 'refundable_until'; timestamp: string }
  | { type: 'rating_at_least'; value: number; scale: 5 }
  | { type: 'text_match'; field: 'city' | 'hotelName' | 'roomType'; expected: string };

export interface HotelBooking {
  quoteId: string;
  merchant: string;
  hotelName: string;
  roomType: string;
  city: string;
  startsOn: string;
  endsOn: string;
  total: number;
  currency: 'USD';
  rating: number;
  refundableUntil: string;
  cancellationTerms: string;
}

export interface RecoveryPolicy {
  allowMerchantCancellation: boolean;
  allowMerchantRefundRequest: boolean;
  allowReplacement: boolean;
  allowRebooking: boolean;
  disputeRequiresConfirmation: true;
  recoveryDeadline?: string;
}

export interface MandateEvidence {
  contractVersion: number;
  renderedSummaryHash: string;
  approvedBy: string;
  approvedAt: string;
  channel: 'web' | 'mobile';
  networkMandateRef?: string;
  /**
   * Agent binding. Optional so contracts approved before agent identity
   * existed (the hotel regression fixtures) remain valid; when present,
   * execute() requires an authenticated agent matching these values.
   */
  agentLineageId?: string;
  authorizedAgentVersionId?: string;
  financialMandateId?: string;
}

export interface OutcomeContract {
  version: number;
  goal: string;
  category: 'travel';
  currency: 'USD';
  maximumTotal: number;
  hardConstraints: OutcomeConstraint[];
  preferences: OutcomeConstraint[];
  unresolvedHardConstraints: string[];
  /**
   * Which funding source this contract draws on. Checked against the
   * mandate at authorization. Optional so contracts predating funding
   * binding stay valid; when set, it must match the mandate's.
   */
  fundingSourceId?: string;
  permittedMerchants?: string[];
  expiresAt: string;
  approvalPolicy: 'confirm_exact_purchase';
  purchase: HotelBooking;
  successConditions: ('booking_matches_contract' | 'payment_captured')[];
  recoveryPolicy: RecoveryPolicy;
  approvalEvidence?: MandateEvidence;
}

export type ContractInput = Omit<OutcomeContract, 'version' | 'approvalEvidence'>;
export type ConsumerApproval = Omit<MandateEvidence, 'approvedBy' | 'approvedAt'>;
export type RecoveryAction = 'cancel' | 'refund' | 'replace' | 'rebook' | 'dispute';

export interface BookingEvidence extends OutcomeEvidence {
  source: 'merchant' | 'email';
  externalId: string;
  operationKey: string;
  bookingRef: string;
  status: 'confirmed' | 'failed' | 'cancelled';
  booking: HotelBooking;
}

export interface PaymentFact {
  externalId: string;
  operationKey: string;
  transactionRef: string;
  kind: 'authorized' | 'captured' | 'unpaid' | 'reversed' | 'refund_acknowledged' | 'refunded';
  amount: number;
  currency: 'USD';
  merchant: string;
}

export interface OutcomeAssessment {
  status: 'success' | 'failure' | 'pending' | 'unknown';
  reasons: string[];
}

export type PurchaseMissionStatus = 'draft' | 'authorized' | 'executing' | 'outcome_pending'
  | 'succeeded' | 'recovery_required' | 'recovering' | 'refunded' | 'partially_recovered'
  | 'unrecoverable' | 'cancelled' | 'expired';

export interface PurchaseMission {
  missionId: string;
  consumerId: string;
  status: PurchaseMissionStatus;
  revision: number;
  contract: OutcomeContract;
  contracts: OutcomeContract[];
  authorizationId?: string;
  operation?: PurchaseOperation;
  revoked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOperation {
  key: string;
  contractVersion: number;
  /** Which agent version exercised the mandate for this operation. */
  agentVersionId?: string;
  financialMandateId?: string;
  reservationId: string;
  authorizationId: string;
  maximumCost: number;
  capabilityRef?: string;
  executionRef?: string;
}

type EventBody =
  | { type: 'contract_created'; data: { consumerId: string; contract: OutcomeContract } }
  | { type: 'contract_revised'; data: { contract: OutcomeContract } }
  | { type: 'consumer_approved'; data: MandateEvidence }
  | { type: 'execution_started'; data: PurchaseOperation }
  | { type: 'credential_issued'; data: { capabilityRef: string } }
  | { type: 'agent_authority_checked'; data: { stage: 'pre_reservation' | 'pre_dispatch'; mandateId: string; agentVersionId: string; allowed: boolean; reasons: string[] } }
  | { type: 'agent_authority_refused'; data: { stage: 'pre_reservation' | 'pre_dispatch'; mandateId: string; agentVersionId: string; reasons: string[] } }
  | { type: 'execution_observed'; data: { executionRef: string; narrative?: string } }
  | { type: 'operation_pending'; data: { reason: string } }
  | { type: 'payment_observed'; data: PaymentFact }
  | { type: 'booking_observed'; data: BookingEvidence }
  | { type: 'outcome_assessed'; data: OutcomeAssessment }
  | { type: 'recovery_requested'; data: { action: 'cancel' | 'refund'; key: string } }
  | { type: 'refund_pending'; data: { externalId: string; key: string } }
  | { type: 'dispute_approval_requested'; data: { statement: string; hash: string } }
  | { type: 'recovery_case_opened'; data: { caseId: string; openedBy: 'consumer' | 'detector'; packetDigest: string; refundRequested: boolean } }
  | { type: 'mission_revoked'; data: Record<string, never> }
  | { type: 'authority_stopped'; data: Record<string, never> }
  | { type: 'task_settled'; data: TaskReceipt };

export type MissionEventInput = EventBody & {
  source: 'scrip' | 'consumer' | 'execution_provider' | 'payment_provider' | 'merchant' | 'email';
  externalId?: string;
};
export type MissionEvent = MissionEventInput & { eventId: string; missionId: string; occurredAt: string };

export interface MissionReceipt {
  mission: PurchaseMission;
  events: MissionEvent[];
  /** Agent lineage/version that exercised the mandate, when one was bound. */
  agentLineageId?: string;
  agentVersionId?: string;
  financialMandateId?: string;
  /** Assurance level of the acting version's manifest. Never proves what ran. */
  agentAttestationLevel?: string;
  assessment?: OutcomeAssessment;
  taskReceipt?: TaskReceipt;
  authorized: number;
  reserved: number;
  captured: number;
  reversed: number;
  refunded: number;
  returned: number;
  unrecovered: number;
  netSpend: number;
  refundPending: boolean;
}

export interface ExecutionRequest {
  operationKey: string;
  consumerId: string;
  missionId: string;
  booking: HotelBooking;
  maximumCost: number;
  expiresAt: string;
  singleUse: true;
  capabilityRef: string;
}

export interface ExecutionProvider {
  start(request: ExecutionRequest): Promise<{ executionRef: string; narrative?: string }>;
  getEvidence(operationKey: string): Promise<BookingEvidence[]>;
  stop(operationKey: string): Promise<void>;
}

export interface PaymentCapabilityProvider {
  issue(request: Omit<ExecutionRequest, 'capabilityRef'>): Promise<{ capabilityRef: string }>;
  getFacts(operationKey: string): Promise<PaymentFact[]>;
  revoke(operationKey: string): Promise<void>;
  requestRecovery(request: { operationKey: string; recoveryKey: string; action: 'cancel' | 'refund' }):
    Promise<{ externalId: string }>;
}
