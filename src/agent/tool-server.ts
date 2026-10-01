/**
 * The tools a real agent gets, served over the MCP tool protocol (JSON-RPC).
 * Every call is tied to one purchase trace by the X-Scrip-Trace header the
 * agent's tool config carries. The agent can research however it likes, but
 * it can only spend through request_purchase (checked against the person's
 * confirmed request) and pay (a real Natural payment, held until Scrip's
 * connector releases or denies it). The fingerprint on the payment is
 * computed here from the offer Scrip stored, never supplied by the agent.
 *
 * In catalog runs the agent picks from Scrip's demo catalog by offerId and
 * pays through a Natural approval hold. In web runs it researches real
 * flights itself and calls checkout with the one it picked and the page it
 * found it on. Scrip decides (blocker or observer mode, see checkout.ts),
 * and an accepted checkout is paid as a Natural transfer to the merchant
 * wallet. A checkout held for review waits for a person (review()).
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
import type { MerchantRail } from '../rails/merchant-rail.js';
import { decideCheckout, type ScripMode } from './checkout.js';
import { decidePurchase, decideWithMerchant, parseItem, type PurchaseItem, type PurchaseTask } from '../purchase/purchase.js';
import { canonicalProduct, type CartHttp, compareOrders, liveCartHttp, merchantOrder } from '../merchant/accept-merchant.js';
import { judgeMusts, type JudgeRunner, claudeJudge } from '../purchase/judge.js';
import { checkSource, type FetchPage, fetchPublicPage } from './source-check.js';

export interface RunContext {
  traceId: string; agent: AuthenticatedAgent; mandateId: string;
  /** Natural approval-hold rail, for catalog runs. */
  rail?: Rail;
  /** Web runs: blocker (default) acts on Scrip's decision; observer always pays and records it. */
  scripMode?: ScripMode;
  /** Web and task runs: the Natural wallet acting as the merchant. */
  merchant?: MerchantRail;
  /** Task runs: what the person asked for and confirmed. */
  task?: PurchaseTask;
  /** Task runs: hold even a fully checked cart until the person approves it (for open-ended requests). */
  askFirst?: boolean;
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

const CHECKOUT = {
  name: 'checkout',
  description: "Buy one real round trip you found on the web. Scrip checks it against the customer's confirmed requirements, then the payment is accepted, rejected, or held for the customer's review.",
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

const TASK_UNDERSTANDING = {
  name: 'state_understanding',
  description: "State what you understand the customer requires: their budget and each must-have, in your own words. Call this before checkout.",
  inputSchema: {
    type: 'object',
    properties: { budgetUsd: { type: 'number', description: 'Maximum total the customer will pay, in USD' }, musts: { type: 'array', items: { type: 'string' }, description: 'Each thing the item must be or have' } },
    required: ['budgetUsd', 'musts'],
  },
};

const TASK_CHECKOUT = {
  name: 'checkout',
  description: 'Buy one item you found on the web. The payment is accepted, rejected, or held for the customer to review.',
  inputSchema: {
    type: 'object',
    properties: {
      merchant: { type: 'string', description: 'Store or seller' },
      item: { type: 'string', description: 'Product name as the page shows it' },
      details: { type: 'string', description: 'Size, color, model, delivery date, and anything else that matters, as the page shows it' },
      option: { type: 'string', description: 'Size, color, or other option exactly as the store names it (e.g. "9" or "9 / Black"), if the item has options' },
      quantity: { type: 'integer' },
      totalUsd: { type: 'number', description: 'Total price in USD, as shown on the page' },
      url: { type: 'string', description: "The item's own product page (not a search, category, or collection page); the merchant prices the order from it" },
    },
    required: ['merchant', 'item', 'details', 'totalUsd', 'url'],
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
    private judge: JudgeRunner = claudeJudge,
    private cartHttp: CartHttp = liveCartHttp,
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
      const kind = traceId ? this.contexts.get(traceId)?.flights : undefined;
      return reply({ tools: kind === 'task' ? [TASK_UNDERSTANDING, TASK_CHECKOUT] : kind === 'web' ? [TOOLS[1], CHECKOUT] : TOOLS });
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
      if (ctx.flights === 'task') {
        if (name === 'state_understanding') return this.understandTask(ctx, args);
        if (name === 'checkout') return await this.checkoutTask(ctx, args);
        return error(`Unknown tool ${name}`);
      }
      switch (name) {
        case 'search_flights': return ctx.flights === 'web' ? error('Research real flights on the web instead.') : ok(catalog.map(describeOffer));
        case 'state_understanding': return this.understand(ctx, args);
        case 'request_purchase': return ctx.flights === 'web' ? error('Use checkout.') : await this.requestPurchase(ctx, args);
        case 'pay': return ctx.flights === 'web' ? error('Use checkout.') : await this.pay(ctx, args);
        case 'checkout': return ctx.flights === 'web' ? await this.checkout(ctx, args) : error('Use request_purchase and pay.');
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
    const offer = findOffer(String(a.offerId ?? ''));
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    if (!ctx.rail) return error('No payment rail for this run.');
    const decision = await this.service.proposePurchase(ctx.traceId, ctx.agent, ctx.mandateId, offer, ctx.rail.naturalAgentId);
    if (decision.approved) return ok({ approved: true, offerId: offer.offerId, message: 'Purchase approved. You may now pay for this offer.' });
    return ok(ctx.refusalFeedback === 'ask_customer'
      ? { approved: false, refused: true, message: "Purchase refused: it does not match what the customer confirmed. Do not pay, and do not try other offers. Stop and ask the customer what they need." }
      : { approved: false, refused: true, reasons: decision.reasons, message: 'Purchase refused. Do not pay.' });
  }

  private async pay(ctx: RunContext, a: Json): Promise<Json> {
    const offerId = String(a.offerId ?? '');
    const offer = findOffer(offerId);
    if (!offer) return error(`No offer ${String(a.offerId)}`);
    if (!ctx.rail) return error('No payment rail for this run.');
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

  /** Checkouts held for a person's review, by attempt id. They outlive the agent's run. */
  private pending = new Map<string, { traceId: string; pay: () => Promise<{ transferId: string; status: string }> }>();

  private async checkout(ctx: RunContext, a: Json): Promise<Json> {
    if (!ctx.merchant) return error('No merchant rail for this run.');
    const parsed = parseWebOffer(a, `web-${(ctx.webOffers?.size ?? 0) + 1}`);
    if (typeof parsed === 'string') return error(parsed);
    const offer = parsed;
    (ctx.webOffers ??= new Map()).set(offer.offerId, offer);
    const sourceUrl = String(a.sourceUrl);
    // Everything the agent read before this checkout: search results and page summaries.
    const research = this.service.events(ctx.traceId)
      .flatMap(e => (e.type === 'agent_tool_result' && ['WebSearch', 'WebFetch'].includes(e.data.tool) ? [e.data.output] : [])).join('\n');
    const mode = ctx.scripMode ?? 'blocker';
    const verdict = decideCheckout(this.service.requirementsFor(ctx.traceId), offer, research, mode);
    this.service.recordCandidate(ctx.traceId, { offer, violations: verdict.violations });
    this.service.recordSourceCheck(ctx.traceId, await checkSource(offer, sourceUrl, this.fetchPage));
    const attemptId = `${ctx.traceId}:${offer.offerId}`;
    this.service.recordAttempt(ctx.traceId, { attemptId, label: `${offer.carrier} ${offer.outbound.map(l => l.flight).join(' + ')}`, amountCents: offer.totalCents, offer, sourceUrl, mode, decision: verdict.decision, blockerDecision: verdict.blockerDecision, reasons: verdict.reasons });

    if (verdict.decision === 'rejected') {
      return ok(ctx.refusalFeedback === 'ask_customer'
        ? { status: 'rejected', message: 'Payment rejected: it does not match what the customer confirmed. Do not try other flights. Stop and ask the customer what they need.' }
        : { status: 'rejected', reasons: verdict.reasons, message: 'Payment rejected. No money moved.' });
    }
    if (verdict.decision === 'in_review') {
      const merchant = ctx.merchant;
      this.pending.set(attemptId, { traceId: ctx.traceId, pay: () => this.moveMoney(ctx.traceId, attemptId, offer, merchant) });
      return ok({ status: 'in_review', message: 'Payment is held for the customer to review. No money has moved yet. Do not retry; finish and report what you submitted.' });
    }
    const moved = await this.moveMoney(ctx.traceId, attemptId, offer, ctx.merchant);
    return ok({ status: moved.status === 'COMPLETED' ? 'accepted' : 'failed', transferId: moved.transferId, message: moved.status === 'COMPLETED' ? 'Payment accepted and completed.' : `Payment failed on Natural (${moved.status}).` });
  }

  private understandTask(ctx: RunContext, a: Json): Json {
    const musts = Array.isArray(a.musts) ? a.musts.map(m => String(m)).filter(Boolean).slice(0, 20) : [];
    this.service.recordPurchaseUnderstanding(ctx.traceId, { budgetCents: Math.round(Number(a.budgetUsd ?? 0) * 100), musts });
    return ok({ recorded: true });
  }

  private async checkoutTask(ctx: RunContext, a: Json): Promise<Json> {
    if (!ctx.merchant || !ctx.task) return error('This run has no task or merchant.');
    const item = parseItem(a);
    if (typeof item === 'string') return error(item);
    const n = this.service.events(ctx.traceId).filter(e => e.type === 'payment_attempted').length + 1;
    const attemptId = `${ctx.traceId}:item-${n}`;
    const events = this.service.events(ctx.traceId);
    const research = events.flatMap(e => (e.type === 'agent_tool_result' && ['WebSearch', 'WebFetch'].includes(e.data.tool) ? [e.data.output] : [])).join('\n');
    const toolInputs = new Map(events.flatMap(e => (e.type === 'agent_tool_call' ? [[e.data.toolUseId, e.data.input] as const] : [])));
    // What the agent got back from the page it is buying from (successful opens of that same page only).
    const key = (u: string): string => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return u; } };
    const citedTexts = events.flatMap(e => {
      if (e.type !== 'agent_tool_result' || e.data.tool !== 'WebFetch' || e.data.isError || /HTTP [45]\d\d/.test(e.data.output.slice(0, 200))) return [];
      const input = toolInputs.get(e.data.toolUseId);
      const url = input && typeof input === 'object' ? (input as Json).url : undefined;
      return typeof url === 'string' && key(url) === key(item.url) ? [e.data.output] : [];
    });
    const cited = citedTexts.length ? { text: citedTexts.join('\n') } : null;
    const judged = await judgeMusts(item, ctx.task.musts, this.judge);
    const mode = ctx.scripMode ?? 'blocker';
    const evidence = decidePurchase(ctx.task, item, research, cited, judged.checks, mode);
    // The stand-in Accept merchant prices the order from the store's own data; its fingerprint is compared with the approved order's.
    const where = canonicalProduct(item.url);
    const reply = await merchantOrder(item.url, item.quantity, this.fetchPage, item.option, this.cartHttp);
    // Options are compared only when the store has them (Shopify variants); otherwise both sides leave it empty.
    // When the store recognizes the agent's option ("Jet Black / 9" = store's "9"), the approved order uses the store's name for it.
    const option = reply.status === 'priced' && reply.order.source !== 'schema.org' ? (reply.order.optionMatched ? reply.order.variant : item.option) : undefined;
    const approved = where ? { ...where, quantity: item.quantity, totalCents: item.totalCents, ...(option ? { variant: option } : {}) } : null;
    const comparison = reply.status === 'priced' && approved ? compareOrders(approved, reply.order) : undefined;
    this.service.recordMerchantOrder(ctx.traceId, { attemptId, approved, reply, ...(comparison ? { comparison } : {}) });
    const decided = decideWithMerchant(evidence, reply.status === 'priced' ? { status: 'priced', match: comparison?.match ?? false, differences: comparison?.differences ?? [] } : reply, mode);
    const askNow = ctx.askFirst && decided.decision === 'accepted';
    const verdict = { ...evidence, ...decided, ...(askNow ? { decision: 'in_review' as const, blockerDecision: 'in_review' as const, reasons: ["waiting for you to approve the store's cart"] } : {}) };
    this.service.recordPurchaseChecked(ctx.traceId, { attemptId, item, priceSeen: verdict.priceSeen, pageSeen: verdict.pageSeen, pageOpened: verdict.pageOpened, priceOnPage: verdict.priceOnPage, checks: judged.checks, checkerModel: judged.model, ...(judged.error ? { checkerError: judged.error } : {}) });
    this.service.recordAttempt(ctx.traceId, { attemptId, label: `${item.item} (${item.merchant})`, amountCents: item.totalCents, item, sourceUrl: item.url, mode, decision: verdict.decision, blockerDecision: verdict.blockerDecision, reasons: verdict.reasons });
    if (verdict.decision === 'rejected') {
      return ok(ctx.refusalFeedback === 'ask_customer'
        ? { status: 'rejected', message: 'Payment rejected: it does not match what the customer asked for. Do not try other items. Stop and ask the customer what they need.' }
        : { status: 'rejected', reasons: verdict.reasons, message: 'Payment rejected. No money moved.' });
    }
    if (verdict.decision === 'in_review') {
      this.pending.set(attemptId, { traceId: ctx.traceId, pay: () => this.payItem(ctx.traceId, attemptId, item, ctx.merchant as MerchantRail) });
      return ok({ status: 'in_review', message: 'Payment is held for the customer to review. No money has moved yet. Do not retry; finish and report what you submitted.' });
    }
    const moved = await this.payItem(ctx.traceId, attemptId, item, ctx.merchant);
    return ok({ status: moved.status === 'COMPLETED' ? 'accepted' : 'failed', message: moved.status === 'COMPLETED' ? 'Payment accepted and completed.' : `Payment failed on Natural (${moved.status}).` });
  }

  private async payItem(traceId: string, attemptId: string, item: PurchaseItem, merchant: MerchantRail) {
    const transfer = await merchant.pay({
      amountCents: item.totalCents, description: `${item.merchant}: ${item.item}`.slice(0, 80), idempotencyKey: `scrip-${attemptId}`,
      tags: { scrip_trace_id: traceId, scrip_merchant: item.merchant.slice(0, 250), scrip_item_fp: orderFingerprint(item) },
    });
    this.service.recordMoneyMoved(traceId, { attemptId, transferId: transfer.transferId, amountCents: item.totalCents, from: transfer.from, to: transfer.to, status: transfer.status });
    return transfer;
  }

  /** A person approves or denies a held checkout. Approving moves the money. */
  async review(attemptId: string, approve: boolean, by = 'customer'): Promise<{ ok: boolean; message: string }> {
    const held = this.pending.get(attemptId);
    if (!held) return { ok: false, message: 'No checkout is waiting for review with that id.' };
    this.pending.delete(attemptId);
    this.service.recordReview(held.traceId, { attemptId, decision: approve ? 'approved' : 'denied', by });
    if (!approve) return { ok: true, message: 'Denied. No money moved.' };
    const moved = await held.pay();
    return { ok: moved.status === 'COMPLETED', message: `Approved. Natural transfer ${moved.transferId}: ${moved.status}.` };
  }

  private async moveMoney(traceId: string, attemptId: string, offer: FlightOffer, merchant: MerchantRail) {
    const transfer = await merchant.pay({
      amountCents: offer.totalCents, description: paymentDescription(offer), idempotencyKey: `scrip-${attemptId}`,
      tags: { scrip_trace_id: traceId, scrip_offer: offer.offerId, scrip_order_fp: orderFingerprint(offer) },
    });
    this.service.recordMoneyMoved(traceId, { attemptId, transferId: transfer.transferId, amountCents: offer.totalCents, from: transfer.from, to: transfer.to, status: transfer.status });
    return transfer;
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
