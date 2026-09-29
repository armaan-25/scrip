/**
 * In-memory Natural for tests and the offline demo. Mirrors behavior verified
 * in the sandbox: payments over the agent limit hold as IN_REVIEW; the owner
 * approves (COMPLETED) or denies (APPROVAL_DENIED); an agent cannot approve.
 */
import type { AgentPayer, HeldPayment, NaturalPort } from './natural-port.js';
import { NaturalPortError } from './natural-port.js';

interface FakePayment { amountCents: number; tags: Record<string, string>; status: string; senderAgentId: string }
interface FakeApproval { paymentId: string; status: 'pending' | 'approved' | 'denied' }

export class FakeNatural implements NaturalPort {
  limitCents: number | null = null;
  failNextApprove = false;
  /** Apply the next approve on Natural's side but throw as if the response was lost. */
  loseNextApproveResponse = false;
  failNextList = false;
  private seq = 0;
  private payments = new Map<string, FakePayment>();
  private approvals = new Map<string, FakeApproval>();

  agent(agentId: string): AgentPayer {
    return {
      pay: async ({ amountCents, tags }) => {
        const n = ++this.seq;
        const paymentId = `pay_fake_${n}`;
        const held = this.limitCents !== null && amountCents > this.limitCents;
        this.payments.set(paymentId, { amountCents, tags: { ...tags }, status: held ? 'IN_REVIEW' : 'COMPLETED', senderAgentId: agentId });
        if (held) this.approvals.set(`apr_fake_${n}`, { paymentId, status: 'pending' });
        return { paymentId, status: held ? 'IN_REVIEW' : 'COMPLETED' };
      },
      approveHold: async () => { throw new NaturalPortError(403, 'You do not have permission to perform this action.'); },
    };
  }

  async listPendingHolds(): Promise<HeldPayment[]> {
    if (this.failNextList) { this.failNextList = false; throw new NaturalPortError(503, 'temporarily unavailable'); }
    return [...this.approvals].filter(([, a]) => a.status === 'pending').map(([approvalId, a]) => {
      const p = this.payment(a.paymentId);
      return { approvalId, paymentId: a.paymentId, amountCents: p.amountCents, tags: p.tags, senderAgentId: p.senderAgentId, reasons: ['limitExceeded:perTransactionAmount'] };
    });
  }

  async approveHold(approvalId: string): Promise<void> {
    if (this.failNextApprove) { this.failNextApprove = false; throw new NaturalPortError(503, 'temporarily unavailable'); }
    const a = this.pendingApproval(approvalId);
    a.status = 'approved';
    this.payment(a.paymentId).status = 'COMPLETED';
    if (this.loseNextApproveResponse) { this.loseNextApproveResponse = false; throw new NaturalPortError(504, 'response lost'); }
  }

  async denyHold(approvalId: string): Promise<void> {
    const a = this.pendingApproval(approvalId);
    a.status = 'denied';
    this.payment(a.paymentId).status = 'APPROVAL_DENIED';
  }

  async getPaymentStatus(paymentId: string): Promise<string> { return this.payment(paymentId).status; }

  private payment(id: string): FakePayment {
    const p = this.payments.get(id);
    if (!p) throw new NaturalPortError(404, `payment ${id} not found`);
    return p;
  }

  private pendingApproval(id: string): FakeApproval {
    const a = this.approvals.get(id);
    if (!a || a.status !== 'pending') throw new NaturalPortError(409, `approval ${id} is not pending`);
    return a;
  }
}
