/** The few Natural operations the connector and demo need. Real SDK and in-memory fake both implement these. */
export interface HeldPayment {
  approvalId: string;
  paymentId: string;
  amountCents: number;
  tags: Record<string, string>;
  senderAgentId: string | null;
  reasons: string[];
}

/** Owner-side access (party key): sees and resolves holds. */
export interface NaturalPort {
  listPendingHolds(): Promise<HeldPayment[]>;
  approveHold(approvalId: string): Promise<void>;
  denyHold(approvalId: string, reason: string): Promise<void>;
  getPaymentStatus(paymentId: string): Promise<string>;
}

/** Agent-side access (agent key): pays; may not approve its own holds. */
export interface AgentPayer {
  pay(input: { amountCents: number; recipient: string; description: string; tags: Record<string, string>; instanceId: string }): Promise<{ paymentId: string; status: string }>;
  approveHold(approvalId: string): Promise<void>;
}

export class NaturalPortError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Statuses after which a payment will not change. */
export const TERMINAL_STATUSES = new Set(['COMPLETED', 'APPROVAL_DENIED', 'FAILED', 'CANCELED', 'RETURNED']);
