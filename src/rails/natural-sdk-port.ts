/**
 * Natural via the official SDK, plus direct calls for two things the installed
 * SDK lacks: agent limits (PATCH /agents/{id} with an Idempotency-Key) and the
 * sandbox's simulated payer. Response shapes verified in the sandbox 2026-09-28.
 */
import { randomUUID } from 'node:crypto';
import { NaturalClient } from '@naturalpay/sdk';
import type { AgentPayer, HeldPayment, NaturalPort } from './natural-port.js';
import { NaturalPortError } from './natural-port.js';

interface ApprovalRow { id: string; attributes: { status: string; target: { type: string; id: string }; reasons: { type: string; limitType?: string }[] } }
interface PaymentRow { id: string; attributes: { amount: number; status: string; tags: Record<string, string> | null }; relationships?: { senderAgent?: { data: { id: string } | null } } }
interface AgentRow { id: string; attributes: { limits: unknown } }
interface SdkLike {
  approvals: {
    list(): Promise<{ data: ApprovalRow[] }>;
    approve(r: { idempotencyKey: string; approvalId: string }): Promise<unknown>;
    deny(r: { idempotencyKey: string; approvalId: string; reason: string }): Promise<unknown>;
  };
  payments: { get(r: { paymentId: string }): Promise<{ data: PaymentRow }>; create(r: Record<string, unknown>): Promise<{ data: PaymentRow }> };
  agents: { list(): Promise<{ data: AgentRow[] }> };
  paymentRequests: { create(r: Record<string, unknown>): Promise<{ data: { id: string } }> };
}

const wrap = (error: unknown): NaturalPortError => {
  const e = error as { statusCode?: number; message?: string };
  return new NaturalPortError(e.statusCode ?? 500, e.message ?? String(error));
};

export class SdkNaturalPort implements NaturalPort {
  private client: SdkLike;
  constructor(private opts: { token: string; baseUrl: string; instanceId: string }) {
    this.client = new NaturalClient({ token: opts.token, baseUrl: opts.baseUrl, instanceId: opts.instanceId }) as unknown as SdkLike;
  }

  async listPendingHolds(): Promise<HeldPayment[]> {
    try {
      const { data } = await this.client.approvals.list(); // first page only; fine for the demo
      const pending = data.filter(a => a.attributes.status === 'pending' && a.attributes.target.type === 'payment');
      return await Promise.all(pending.map(async a => {
        const { data: p } = await this.client.payments.get({ paymentId: a.attributes.target.id });
        return {
          approvalId: a.id, paymentId: p.id, amountCents: p.attributes.amount, tags: p.attributes.tags ?? {},
          senderAgentId: p.relationships?.senderAgent?.data?.id ?? null,
          reasons: a.attributes.reasons.map(r => [r.type, r.limitType].filter(Boolean).join(':')),
        };
      }));
    } catch (error) { throw wrap(error); }
  }

  async approveHold(approvalId: string): Promise<void> {
    try { await this.client.approvals.approve({ idempotencyKey: `approve:${approvalId}`, approvalId }); } catch (error) { throw wrap(error); }
  }

  async denyHold(approvalId: string, reason: string): Promise<void> {
    try { await this.client.approvals.deny({ idempotencyKey: `deny:${approvalId}`, approvalId, reason: reason.slice(0, 500) }); } catch (error) { throw wrap(error); }
  }

  async getPaymentStatus(paymentId: string): Promise<string> {
    try { return (await this.client.payments.get({ paymentId })).data.attributes.status; } catch (error) { throw wrap(error); }
  }

  async listAgentIds(): Promise<{ id: string; limits: unknown }[]> {
    return (await this.client.agents.list()).data.map(a => ({ id: a.id, limits: a.attributes.limits }));
  }

  async setAgentLimits(agentId: string, limits: unknown): Promise<void> {
    await this.raw('PATCH', `/agents/${agentId}`, { data: { attributes: { limits } } });
  }

  /** Sandbox only: ask the funded payer fixture for money and simulate it paying. */
  async fundWallet(cents: number): Promise<void> {
    const request = await this.client.paymentRequests.create({
      idempotencyKey: randomUUID(), amount: cents, currency: 'USD', description: 'Test money for the Scrip demo', payerName: 'Sandbox Payer',
      payer: { type: 'email', value: 'payment-request-payer@sandbox.natural.test' },
    });
    await this.raw('POST', `/simulations/payment-requests/${request.data.id}/fulfill`);
  }

  private async raw(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new NaturalPortError(res.status, text.slice(0, 300));
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

export class SdkAgentPayer implements AgentPayer {
  private client: SdkLike;
  constructor(opts: { token: string; baseUrl: string; instanceId: string }) {
    this.client = new NaturalClient({ token: opts.token, baseUrl: opts.baseUrl, instanceId: opts.instanceId }) as unknown as SdkLike;
  }

  async pay(input: { amountCents: number; recipient: string; description: string; tags: Record<string, string>; instanceId: string }): Promise<{ paymentId: string; status: string }> {
    try {
      const { data } = await this.client.payments.create({
        idempotencyKey: randomUUID(), amount: input.amountCents, currency: 'USD', description: input.description,
        counterparty: { type: 'email', value: input.recipient }, tags: input.tags,
      });
      return { paymentId: data.id, status: data.attributes.status };
    } catch (error) { throw wrap(error); }
  }

  async approveHold(approvalId: string): Promise<void> {
    try { await this.client.approvals.approve({ idempotencyKey: randomUUID(), approvalId }); } catch (error) { throw wrap(error); }
  }
}
