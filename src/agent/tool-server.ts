/**
 * The tools a real agent gets, served over the MCP tool protocol (JSON-RPC).
 * Every call is tied to one purchase trace by the X-Scrip-Trace header the
 * agent's tool config carries. The agent can research however it likes, but
 * it can only spend through request_purchase (checked against the person's
 * confirmed request) and pay (a real Natural payment, held until Scrip's
 * connector releases or denies it). The fingerprint on the payment is
 * computed here from the catalog offer, never supplied by the agent.
 */
import type { FlightRequirements } from '../flights/types.js';
import type { AuthenticatedAgent } from '../missions/agent-identity.js';
import { NaturalHoldConnector } from '../rails/natural-hold-connector.js';
import type { Rail } from '../rails/rail-setup.js';
import { settlePayment } from '../rails/settle.js';
import { orderFingerprint } from '../trace/fingerprint.js';
import type { FlightTraceService } from '../trace/trace-service.js';
import { catalog, describeOffer, findOffer } from './catalog.js';

export interface RunContext { traceId: string; agent: AuthenticatedAgent; mandateId: string; rail: Rail }

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

const TOOLS = [
  {
    name: 'search_flights',
    description: 'Search the airline catalog for round-trip flights.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: '3-letter airport code, e.g. JFK' }, to: { type: 'string', description: '3-letter airport code, e.g. SFO' }, departOn: { type: 'string', description: 'YYYY-MM-DD' }, returnOn: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['from', 'to'] },
  },
  {
    name: 'state_understanding',
    description: "State your understanding of what the customer requires, as structured fields. Required before request_purchase.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '3-letter airport code, e.g. JFK' }, to: { type: 'string', description: '3-letter airport code, e.g. SFO' },
        departOn: { type: 'string', description: 'YYYY-MM-DD' }, returnOn: { type: 'string', description: 'YYYY-MM-DD' },
        directOnly: { type: 'boolean', description: 'True if the customer requires nonstop flights' },
        refundableOnly: { type: 'boolean', description: 'True if the customer requires a refundable fare' },
        maxTotalUsd: { type: 'number', description: 'Maximum total price in US dollars' },
      },
      required: ['from', 'to', 'departOn', 'returnOn', 'directOnly', 'refundableOnly', 'maxTotalUsd'],
    },
  },
  {
    name: 'request_purchase',
    description: "Ask to buy one offer. Scrip checks it against the customer's confirmed requirements and approves or refuses.",
    inputSchema: { type: 'object', properties: { offerId: { type: 'string' } }, required: ['offerId'] },
  },
  {
    name: 'pay',
    description: 'Pay for an offer on Natural. Only an approved purchase will be released.',
    inputSchema: { type: 'object', properties: { offerId: { type: 'string' } }, required: ['offerId'] },
  },
];

export class ScripToolServer {
  constructor(private service: FlightTraceService, private contexts: Map<string, RunContext>, private log: (line: string) => void = () => {}) {}

  /** Handle one JSON-RPC message. Returns null for notifications (no reply). */
  async handle(body: unknown, traceId: string | undefined): Promise<Json | null> {
    const req = obj(body);
    const id = req.id;
    const method = typeof req.method === 'string' ? req.method : '';
    if (id === undefined || id === null) return null;
    const reply = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const version = obj(req.params).protocolVersion;
      return reply({ protocolVersion: typeof version === 'string' ? version : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'scrip', version: '1.0.0' } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const params = obj(req.params);
      return reply(await this.call(String(params.name ?? ''), obj(params.arguments), traceId));
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } };
  }

  private async call(name: string, args: Json, traceId: string | undefined): Promise<Json> {
    const ctx = traceId ? this.contexts.get(traceId) : undefined;
    if (!ctx) return error('This tool call is not tied to an active purchase.');
    try {
      switch (name) {
        case 'search_flights': return ok(catalog.map(describeOffer));
        case 'state_understanding': return this.understand(ctx, args);
        case 'request_purchase': return await this.requestPurchase(ctx, args);
        case 'pay': return await this.pay(ctx, args);
        default: return error(`Unknown tool ${name}`);
      }
    } catch (e) {
      this.log(`tool ${name} failed: ${(e as Error).message}`);
      return error((e as Error).message);
    }
  }

  private understand(ctx: RunContext, a: Json): Json {
    const interpretation: FlightRequirements = {
      from: String(a.from ?? ''), to: String(a.to ?? ''), departOn: String(a.departOn ?? ''), returnOn: String(a.returnOn ?? ''),
      directOnly: a.directOnly === true, refundableOnly: a.refundableOnly === true,
      maxTotalCents: Math.round(Number(a.maxTotalUsd ?? 0) * 100),
    };
    const differences = this.service.recordInterpretation(ctx.traceId, ctx.agent, interpretation);
    return ok(differences.length
      ? { recorded: true, note: 'Your understanding differs from what the customer confirmed in some fields. It has been recorded.' }
      : { recorded: true, note: 'Your understanding matches what the customer confirmed.' });
  }

  private async requestPurchase(ctx: RunContext, a: Json): Promise<Json> {
    const offer = findOffer(String(a.offerId ?? ''));
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    const decision = await this.service.proposePurchase(ctx.traceId, ctx.agent, ctx.mandateId, offer, ctx.rail.naturalAgentId);
    return ok(decision.approved
      ? { approved: true, offerId: offer.offerId, message: 'Purchase approved. You may now pay for this offer.' }
      : { approved: false, refused: true, reasons: decision.reasons, message: 'Purchase refused. Do not pay.' });
  }

  private async pay(ctx: RunContext, a: Json): Promise<Json> {
    const offer = findOffer(String(a.offerId ?? ''));
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    if (!this.service.approvedPurchase(ctx.traceId)) return error('No purchase has been approved for this request. Payment not sent.');
    const fingerprintTag = orderFingerprint(offer);
    const payment = await ctx.rail.payer.pay({
      amountCents: offer.totalCents, recipient: ctx.rail.recipient, description: `Flight ${offer.offerId}`, instanceId: ctx.traceId,
      tags: { scrip_trace_id: ctx.traceId, scrip_order_fp: fingerprintTag },
    });
    this.service.recordPaymentSubmitted(ctx.traceId, { paymentId: payment.paymentId, instanceId: ctx.traceId, fingerprintTag, amountCents: offer.totalCents });
    const connector = new NaturalHoldConnector(ctx.rail.owner, this.service);
    const settled = await settlePayment(this.service, connector, ctx.rail.owner, ctx.traceId, payment.paymentId, line => this.log(line ?? ''));
    const paid = settled.outcome === 'paid';
    return ok({ paymentId: payment.paymentId, status: settled.finalStatus ?? 'undecided', message: paid ? 'Payment COMPLETED.' : 'Payment was denied and not sent: it does not match the approved purchase.' });
  }
}

const ok = (value: unknown): Json => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const error = (message: string): Json => ({ content: [{ type: 'text', text: message }], isError: true });
