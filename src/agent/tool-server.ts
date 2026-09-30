/**
 * The tools a real agent gets, served over the MCP tool protocol (JSON-RPC).
 * Every call is tied to one purchase trace by the X-Scrip-Trace header the
 * agent's tool config carries. The agent can research however it likes, but
 * it can only spend through request_purchase (checked against the person's
 * confirmed request) and pay (a real Natural payment, held until Scrip's
 * connector releases or denies it). The fingerprint on the payment is
 * computed here from the offer Scrip stored, never supplied by the agent.
 *
 * In catalog runs the agent picks from Scrip's demo catalog by offerId. In
 * web runs it researches real flights itself and submits the one it picked,
 * with the page it found it on; Scrip stores that as the offer (web-1, ...).
 * Scrip cannot confirm a web price independently; the source URL is recorded
 * in the trace as the agent's evidence.
 */
import { paymentDescription } from '../flights/rules.js';
import type { FlightLeg, FlightOffer, FlightRequirements } from '../flights/types.js';
import type { AuthenticatedAgent } from '../missions/agent-identity.js';
import { NaturalHoldConnector } from '../rails/natural-hold-connector.js';
import type { Rail } from '../rails/rail-setup.js';
import { settlePayment } from '../rails/settle.js';
import { orderFingerprint } from '../trace/fingerprint.js';
import type { FlightTraceService } from '../trace/trace-service.js';
import { catalog, describeOffer, findOffer } from './catalog.js';
import type { FlightSource } from './profiles.js';
import { checkSource, type FetchPage, fetchPublicPage } from './source-check.js';

export interface RunContext {
  traceId: string; agent: AuthenticatedAgent; mandateId: string; rail: Rail;
  /** Defaults to catalog. */
  flights?: FlightSource;
  /** Offers the agent submitted from the web in this run, by Scrip-assigned id. */
  webOffers?: Map<string, FlightOffer>;
  /**
   * What a refusal tells the agent. explain (default) names the reasons, which
   * reveals the person's requirements; ask_customer only says to stop and ask.
   * Scrip records the reasons either way.
   */
  refusalFeedback?: 'explain' | 'ask_customer';
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

const LEG = {
  type: 'object',
  properties: {
    flight: { type: 'string', description: 'Flight number, e.g. B6 415' },
    from: { type: 'string', description: '3-letter airport code' }, to: { type: 'string', description: '3-letter airport code' },
    departAt: { type: 'string', description: 'Local departure time, YYYY-MM-DDTHH:MM' }, arriveAt: { type: 'string', description: 'Local arrival time, YYYY-MM-DDTHH:MM' },
  },
  required: ['flight', 'from', 'to', 'departAt', 'arriveAt'],
};

const WEB_REQUEST_PURCHASE = {
  name: 'request_purchase',
  description: "Ask to buy one real round trip you found on the web. Scrip checks it against the customer's confirmed requirements and approves or refuses. Returns the offerId to pay.",
  inputSchema: {
    type: 'object',
    properties: {
      airline: { type: 'string' },
      outbound: { type: 'array', items: LEG, description: 'Outbound flights in order (one for nonstop)' },
      inbound: { type: 'array', items: LEG, description: 'Return flights in order (one for nonstop)' },
      totalUsd: { type: 'number', description: 'Total round-trip price in USD for one adult, as shown on the page' },
      refundable: { type: 'boolean', description: 'True only if the page says this fare is refundable' },
      sourceUrl: { type: 'string', description: 'URL of the page where you found this flight and price' },
    },
    required: ['airline', 'outbound', 'inbound', 'totalUsd', 'refundable', 'sourceUrl'],
  },
};

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
  constructor(
    private service: FlightTraceService,
    private contexts: Map<string, RunContext>,
    private log: (line: string) => void = () => {},
    private fetchPage: FetchPage = fetchPublicPage,
  ) {}

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
    if (method === 'tools/list') {
      const web = traceId ? this.contexts.get(traceId)?.flights === 'web' : false;
      return reply({ tools: web ? [TOOLS[1], WEB_REQUEST_PURCHASE, TOOLS[3]] : TOOLS });
    }
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
        case 'search_flights': return ctx.flights === 'web' ? error('Research real flights on the web instead.') : ok(catalog.map(describeOffer));
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
    if (ctx.refusalFeedback === 'ask_customer') return ok({ recorded: true });
    return ok(differences.length
      ? { recorded: true, note: 'Your understanding differs from what the customer confirmed in some fields. It has been recorded.' }
      : { recorded: true, note: 'Your understanding matches what the customer confirmed.' });
  }

  private async requestPurchase(ctx: RunContext, a: Json): Promise<Json> {
    let offer: FlightOffer | undefined;
    if (ctx.flights === 'web') {
      const parsed = parseWebOffer(a, `web-${(ctx.webOffers?.size ?? 0) + 1}`);
      if (typeof parsed === 'string') return error(parsed);
      offer = parsed;
      (ctx.webOffers ??= new Map()).set(offer.offerId, offer);
      // Recorded for observability only; the agent is not told, and the purchase check below is unchanged.
      this.service.recordSourceCheck(ctx.traceId, await checkSource(offer, String(a.sourceUrl), this.fetchPage));
    } else {
      offer = findOffer(String(a.offerId ?? ''));
    }
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    const decision = await this.service.proposePurchase(ctx.traceId, ctx.agent, ctx.mandateId, offer, ctx.rail.naturalAgentId);
    if (decision.approved) return ok({ approved: true, offerId: offer.offerId, message: 'Purchase approved. You may now pay for this offer.' });
    return ok(ctx.refusalFeedback === 'ask_customer'
      ? { approved: false, refused: true, message: "Purchase refused: it does not match what the customer confirmed. Do not pay, and do not try other offers. Stop and ask the customer what they need." }
      : { approved: false, refused: true, reasons: decision.reasons, message: 'Purchase refused. Do not pay.' });
  }

  private async pay(ctx: RunContext, a: Json): Promise<Json> {
    const offerId = String(a.offerId ?? '');
    const offer = ctx.flights === 'web' ? ctx.webOffers?.get(offerId) : findOffer(offerId);
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    if (!this.service.approvedPurchase(ctx.traceId)) return error('No purchase has been approved for this request. Payment not sent.');
    const fingerprintTag = orderFingerprint(offer);
    const payment = await ctx.rail.payer.pay({
      amountCents: offer.totalCents, recipient: ctx.rail.recipient, description: paymentDescription(offer), instanceId: ctx.traceId,
      tags: { scrip_trace_id: ctx.traceId, scrip_order_fp: fingerprintTag },
    });
    this.service.recordPaymentSubmitted(ctx.traceId, { paymentId: payment.paymentId, instanceId: ctx.traceId, fingerprintTag, amountCents: offer.totalCents });
    const connector = new NaturalHoldConnector(ctx.rail.owner, this.service);
    const settled = await settlePayment(this.service, connector, ctx.rail.owner, ctx.traceId, payment.paymentId, line => this.log(line ?? ''));
    const paid = settled.outcome === 'paid';
    return ok({ paymentId: payment.paymentId, status: settled.finalStatus ?? 'undecided', message: paid ? 'Payment COMPLETED.' : 'Payment was denied and not sent: it does not match the approved purchase.' });
  }
}

/** Turn the agent's web submission into an offer, or say what is wrong with it. */
export function parseWebOffer(a: Json, offerId: string): FlightOffer | string {
  const legs = (v: unknown, name: string): FlightLeg[] | string => {
    if (!Array.isArray(v) || v.length === 0) return `${name} must list at least one flight`;
    const out: FlightLeg[] = [];
    for (const raw of v) {
      const l = obj(raw);
      const leg = { flight: String(l.flight ?? ''), from: String(l.from ?? '').toUpperCase(), to: String(l.to ?? '').toUpperCase(), departAt: String(l.departAt ?? ''), arriveAt: String(l.arriveAt ?? '') };
      if (!leg.flight || !/^[A-Z]{3}$/.test(leg.from) || !/^[A-Z]{3}$/.test(leg.to) || !/^\d{4}-\d{2}-\d{2}T/.test(leg.departAt) || !/^\d{4}-\d{2}-\d{2}T/.test(leg.arriveAt)) {
        return `${name} flights need a flight number, 3-letter airports, and times like 2026-10-16T07:00`;
      }
      out.push(leg);
    }
    return out;
  };
  const outbound = legs(a.outbound, 'outbound');
  if (typeof outbound === 'string') return outbound;
  const inbound = legs(a.inbound, 'inbound');
  if (typeof inbound === 'string') return inbound;
  const totalUsd = Number(a.totalUsd);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 'totalUsd must be the positive round-trip price in USD';
  const sourceUrl = String(a.sourceUrl ?? '');
  if (!/^https?:\/\//.test(sourceUrl)) return 'sourceUrl must be the http(s) page where you found this flight';
  const airline = String(a.airline ?? '').trim();
  if (!airline) return 'airline is required';
  return { offerId, carrier: airline.slice(0, 40), outbound, inbound, refundable: a.refundable === true, totalCents: Math.round(totalUsd * 100), currency: 'USD' };
}

const ok = (value: unknown): Json => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const error = (message: string): Json => ({ content: [{ type: 'text', text: message }], isError: true });
