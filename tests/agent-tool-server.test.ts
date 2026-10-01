import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScripToolServer, type RunContext } from '../src/agent/tool-server.js';
import { confirmedRequirements, demoRequest } from '../src/flights/fixtures.js';
import { setupRail } from '../src/rails/rail-setup.js';
import { FakeMerchantRail } from '../src/rails/merchant-rail.js';
import { runActivity } from '../src/trace/activity.js';
import { monitorAlerts } from '../src/trace/monitors.js';
import { createTraceWorld, type TraceWorld } from './helpers/trace-world.js';

let world: TraceWorld;
let server: ScripToolServer;
let traceId: string;

const call = async (name: string, args: Record<string, unknown>, id = 1, trace: string | undefined = traceId) => {
  const res = await server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, trace);
  const result = (res as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
};

beforeEach(async () => {
  world = createTraceWorld();
  const rail = await setupRail('offline', 'test-run');
  traceId = world.service.start('armaan', demoRequest);
  world.service.confirm(traceId, confirmedRequirements);
  const ctx: RunContext = { traceId, agent: world.agent, mandateId: world.mandateId, rail };
  server = new ScripToolServer(world.service, new Map([[traceId, ctx]]));
});
afterEach(() => world.cleanup());

describe('ScripToolServer', () => {
  it('speaks enough of the tool protocol for the agent to connect', async () => {
    const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, traceId);
    expect(init).toMatchObject({ result: { serverInfo: { name: 'scrip' } } });
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, traceId)).toBeNull();
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, traceId);
    expect((list as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(['search_flights', 'state_understanding', 'request_purchase', 'pay']);
  });

  it('runs a faithful purchase end to end: search, understand, approve, pay, completed', async () => {
    expect((await call('search_flights', { from: 'JFK', to: 'SFO', departOn: '2026-10-16', returnOn: '2026-10-18' })).text).toMatch(/offer-nonstop/);
    expect((await call('state_understanding', { ...confirmedRequirements, maxTotalUsd: 600 })).text).toMatch(/matches/i);
    expect((await call('request_purchase', { offerId: 'offer-nonstop' })).text).toMatch(/approved/i);
    const paid = await call('pay', { offerId: 'offer-nonstop' });
    expect(paid.text).toMatch(/COMPLETED/);
    expect(world.service.hasApprovedPayment(traceId)).toBe(true);
  });

  it('records a misunderstanding and refuses an offer that breaks the request', async () => {
    const understood = await call('state_understanding', { ...confirmedRequirements, directOnly: false, refundableOnly: false, maxTotalUsd: 600 });
    expect(understood.text).toMatch(/differs/i);
    const refused = await call('request_purchase', { offerId: 'offer-layover' });
    expect(refused.text).toMatch(/refused/i);
    expect((await call('pay', { offerId: 'offer-layover' })).isError).toBe(true);
  });

  it('denies paying for a different flight than the one approved', async () => {
    await call('state_understanding', { ...confirmedRequirements, maxTotalUsd: 600 });
    await call('request_purchase', { offerId: 'offer-nonstop' });
    const paid = await call('pay', { offerId: 'offer-basic' });
    expect(paid.text).toMatch(/denied/i);
    expect(world.service.hasApprovedPayment(traceId)).toBe(false);
  });

  it('rejects tool calls that are not tied to a run', async () => {
    expect((await call('search_flights', { from: 'JFK', to: 'SFO' }, 9, 'trc_unknown')).isError).toBe(true);
  });
});

describe('ScripToolServer, real-web checkout', () => {
  const webRequirements = { ...confirmedRequirements, refundableOnly: false, maxTotalCents: 70000 };
  const leg = (flight: string, from: string, to: string, day: string) => ({ flight, from, to, departAt: `${day}T08:00`, arriveAt: `${day}T11:30` });
  const nonstop = {
    airline: 'JetBlue', outbound: [leg('B6 415', 'JFK', 'SFO', '2026-10-16')], inbound: [leg('B6 416', 'SFO', 'JFK', '2026-10-18')],
    totalUsd: 612.4, refundable: false, sourceUrl: 'https://www.google.com/travel/flights/example',
  };
  let merchant: FakeMerchantRail;
  const research = (text: string) => {
    world.service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: 'r1', tool: 'WebFetch', input: { url: 'https://www.jetblue.com' } } });
    world.service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: 'r1', tool: 'WebFetch', output: text, isError: false } });
  };
  const setup = (scripMode: 'blocker' | 'observer') => {
    merchant = new FakeMerchantRail();
    traceId = world.service.start('armaan', 'JFK to SFO Oct 16-18, nonstop, $700 max');
    world.service.confirm(traceId, webRequirements);
    const page = async () => ({ status: 403, text: '' });
    server = new ScripToolServer(world.service, new Map([[traceId, { traceId, agent: world.agent, mandateId: world.mandateId, merchant, scripMode, flights: 'web', webOffers: new Map() }]]), () => {}, page);
  };
  const attempt = () => runActivity(world.service.events(traceId)).attempts.at(-1);

  it('offers only the tools to state an understanding and check out', async () => {
    setup('blocker');
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, traceId);
    expect((list as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(['state_understanding', 'checkout']);
    expect((await call('search_flights', { from: 'JFK', to: 'SFO' })).isError).toBe(true);
  });

  it('blocker: accepts and pays the merchant wallet when the claim is in what the agent read', async () => {
    setup('blocker');
    research('JetBlue B6 415 out, B6 416 back, round trip $612.40');
    expect((await call('checkout', nonstop)).text).toMatch(/"status":"accepted"/);
    expect(merchant.transfers).toMatchObject([{ status: 'COMPLETED', amountCents: 61240, to: 'Example Air (merchant)' }]);
    expect(attempt()).toMatchObject({ status: 'accepted', transferStatus: 'COMPLETED' });
  });

  it("blocker: holds a checkout for review when the price never appeared in the agent's research", async () => {
    setup('blocker');
    research('JFK-SFO 10/16 from $234. SFO-JFK 10/18 from $334. B6 415, B6 416.');
    expect((await call('checkout', nonstop)).text).toMatch(/in_review/);
    expect(merchant.transfers).toEqual([]);
    expect(attempt()).toMatchObject({ status: 'in_review', reasons: ['not found in anything the agent read: price $612.40'] });
    expect(await server.review(attempt()?.attemptId ?? '', true)).toMatchObject({ ok: true });
    expect(merchant.transfers).toHaveLength(1);
    expect(attempt()).toMatchObject({ status: 'approved', transferStatus: 'COMPLETED' });
    expect((await server.review(attempt()?.attemptId ?? '', true)).ok).toBe(false); // cannot be approved twice
  });

  it('blocker: rejects a flight that breaks the request, and a denied review moves nothing', async () => {
    setup('blocker');
    const oneStop = { ...nonstop, totalUsd: 420, outbound: [leg('UA 1', 'JFK', 'DEN', '2026-10-16'), leg('UA 2', 'DEN', 'SFO', '2026-10-16')] };
    expect((await call('checkout', oneStop)).text).toMatch(/rejected/);
    expect(attempt()?.status).toBe('rejected');
    expect(merchant.transfers).toEqual([]);
    expect((await call('checkout', { ...nonstop, sourceUrl: '' })).isError).toBe(true);
    await call('checkout', nonstop); // price never seen: held
    await server.review(attempt()?.attemptId ?? '', false);
    expect(attempt()?.status).toBe('denied');
    expect(merchant.transfers).toEqual([]);
  });

  it('observer: always pays, and records what the blocker would have done', async () => {
    setup('observer');
    const oneStop = { ...nonstop, totalUsd: 420, outbound: [leg('UA 1', 'JFK', 'DEN', '2026-10-16'), leg('UA 2', 'DEN', 'SFO', '2026-10-16')] };
    expect((await call('checkout', oneStop)).text).toMatch(/accepted/);
    expect(attempt()).toMatchObject({ status: 'accepted', mode: 'observer', blockerDecision: 'rejected' });
    expect(merchant.transfers).toHaveLength(1);
  });
});

describe('ScripToolServer, ask-the-customer refusals', () => {
  it('refuses without revealing what the customer confirmed', async () => {
    const rail = await setupRail('offline', 'test-ask');
    traceId = world.service.start('armaan', demoRequest);
    world.service.confirm(traceId, confirmedRequirements);
    server = new ScripToolServer(world.service, new Map([[traceId, { traceId, agent: world.agent, mandateId: world.mandateId, rail, refusalFeedback: 'ask_customer' }]]));
    const understood = await call('state_understanding', { ...confirmedRequirements, directOnly: false, refundableOnly: false, maxTotalUsd: 600 });
    const refused = await call('request_purchase', { offerId: 'offer-layover' });
    for (const text of [understood.text, refused.text]) expect(text).not.toMatch(/direct|refundable|differs|matches/i);
    expect(refused.text).toMatch(/ask the customer/i);
    const recorded = world.service.events(traceId).find(e => e.type === 'purchase_refused');
    expect(recorded?.type === 'purchase_refused' && recorded.data.reasons.length).toBe(2); // Scrip still records why
  });
});

describe('ScripToolServer, any purchase', () => {
  const task = { words: 'Buy a 12-pack of AA batteries', budgetCents: 2000, musts: ['Duracell or Amazon Basics'] };
  const shopUrl = 'https://shop.example/products/aa-12';
  const batteries = { merchant: 'Shop Example', item: 'Amazon Basics AA 12-pack', details: '12 count', quantity: 1, totalUsd: 11.49, url: shopUrl };
  let merchant: FakeMerchantRail;
  let verdict: 'yes' | 'no' | 'unsure';
  let storePrice: string | null; // what the store's own product data says; null = store publishes nothing
  const read = (url: string, text: string) => {
    world.service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: url, tool: 'WebFetch', input: { url } } });
    world.service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: url, tool: 'WebFetch', output: text, isError: false } });
  };
  const store = async (url: string) => (url === `${shopUrl}.json` && storePrice !== null
    ? { status: 200, text: JSON.stringify({ product: { title: 'Amazon Basics AA Batteries 12-Pack', variants: [{ id: 1, title: 'Default Title', price: storePrice, available: true }] } }) }
    : { status: 200, text: '<html>no product data</html>' });
  // A fake store cart: adding the variant returns a session cookie; reading the cart returns the store's own totals.
  let cartDiscountCents = 0;
  const cartHttp = async (req: { method: 'GET' | 'POST'; url: string; body?: string; cookie?: string }) => {
    if (req.method === 'POST') { lastQty = (JSON.parse(req.body ?? '{}') as { items: { quantity: number }[] }).items[0]?.quantity ?? 0; return { status: 200, text: '{}', setCookies: ['cart=c1; path=/'] }; }
    if (req.cookie !== 'cart=c1' || storePrice === null) return { status: 404, text: '', setCookies: [] };
    const line = Math.round(Number(storePrice) * 100) * lastQty - cartDiscountCents;
    return { status: 200, text: JSON.stringify({ token: 'tok123456789xyz', total_price: line, items: [{ product_title: 'Amazon Basics AA Batteries 12-Pack', variant_title: null, quantity: lastQty, final_line_price: line, sku: 'AA12' }] }), setCookies: [] };
  };
  let lastQty = 0;
  const setup = (scripMode: 'blocker' | 'observer', askFirst = false) => {
    merchant = new FakeMerchantRail('Merchant (simulated)');
    verdict = 'yes';
    storePrice = '11.49';
    cartDiscountCents = 0;
    traceId = world.service.start('armaan', task.words);
    world.service.confirmTask(traceId, { budgetCents: task.budgetCents, musts: task.musts });
    const judge = async () => JSON.stringify([{ must: task.musts[0], verdict, reason: 'from the description' }]);
    server = new ScripToolServer(world.service, new Map([[traceId, { traceId, agent: world.agent, mandateId: '', merchant, scripMode, flights: 'task', task, askFirst }]]), () => {}, store, judge, cartHttp);
  };
  const last = () => runActivity(world.service.events(traceId)).attempts.at(-1);
  const kinds = () => monitorAlerts(world.service.events(traceId)).map(a => a.kind);

  it("accepts when the merchant's own order matches the approved order, and pays the merchant wallet", async () => {
    setup('blocker');
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, traceId);
    expect((list as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(['state_understanding', 'checkout']);
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/accepted/);
    expect(merchant.transfers).toMatchObject([{ amountCents: 1149, status: 'COMPLETED', to: 'Merchant (simulated)' }]);
    expect(last()?.merchantOrder?.comparison).toMatchObject({ match: true, differences: [] });
    expect(last()?.merchantOrder?.reply).toMatchObject({ status: 'priced', order: { source: 'cart', sku: 'AA12', totalCents: 1149 } });
    expect(kinds()).toEqual([]);
  });

  it("rejects when the store's own cart total differs from what the agent proposed (e.g. a discount or price change)", async () => {
    setup('blocker');
    cartDiscountCents = 150;
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/rejected/);
    expect(last()?.reasons).toContain('total: approved $11.49, merchant charging $9.99');
  });

  it('ask me first: a fully checked cart still waits for the person, and approving pays', async () => {
    setup('blocker', true);
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/in_review/);
    expect(last()).toMatchObject({ status: 'in_review', reasons: ["waiting for you to approve the store's cart"] });
    expect(merchant.transfers).toEqual([]);
    await server.review(last()?.attemptId ?? '', true);
    expect(merchant.transfers).toHaveLength(1);
  });

  it('accepts on matching merchant details even when the agent only saw the price in a search snippet', async () => {
    setup('blocker');
    world.service.recordAgent(traceId, { type: 'agent_tool_call', data: { toolUseId: 's', tool: 'WebSearch', input: { query: 'aa' } } });
    world.service.recordAgent(traceId, { type: 'agent_tool_result', data: { toolUseId: 's', tool: 'WebSearch', output: 'Amazon Basics AA 12 pack $11.49', isError: false } });
    expect((await call('checkout', batteries)).text).toMatch(/accepted/);
  });

  it("rejects when the merchant charges something other than what was approved, naming the difference", async () => {
    setup('blocker');
    storePrice = '12.99';
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/rejected/);
    expect(last()).toMatchObject({ status: 'rejected', reasons: ['merchant order details do not match the approved order', 'total: approved $11.49, merchant charging $12.99'] });
    expect(merchant.transfers).toEqual([]);
    expect(kinds()).toContain('fingerprint_mismatch');
  });

  it('holds for review when the store sends no order details, and approving pays', async () => {
    setup('blocker');
    storePrice = null;
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/in_review/);
    expect(last()?.reasons[0]).toMatch(/^can't verify with the store: shop.example has no public cart or order data to read/);
    expect(kinds()).toContain('no_order_details');
    await server.review(last()?.attemptId ?? '', true);
    expect(last()?.status).toBe('approved');
    expect(merchant.transfers).toHaveLength(1);
  });

  it('still rejects a missed must-have before asking the merchant, and observer pays but records the blocker decision', async () => {
    setup('blocker');
    verdict = 'no';
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/rejected/);
    setup('observer');
    storePrice = '12.99';
    read(shopUrl, 'Amazon Basics AA 12-pack $11.49');
    expect((await call('checkout', batteries)).text).toMatch(/accepted/);
    expect(last()).toMatchObject({ status: 'accepted', blockerDecision: 'rejected' });
  });
});
