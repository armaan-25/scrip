import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScripToolServer, type RunContext } from '../src/agent/tool-server.js';
import { confirmedRequirements, demoRequest } from '../src/flights/fixtures.js';
import { setupRail } from '../src/rails/rail-setup.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
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

describe('ScripToolServer, real-web flights', () => {
  const webRequirements = { ...confirmedRequirements, refundableOnly: false, maxTotalCents: 70000 };
  const leg = (flight: string, from: string, to: string, day: string) => ({ flight, from, to, departAt: `${day}T08:00`, arriveAt: `${day}T11:30` });
  const nonstop = {
    airline: 'JetBlue', outbound: [leg('B6 415', 'JFK', 'SFO', '2026-10-16')], inbound: [leg('B6 416', 'SFO', 'JFK', '2026-10-18')],
    totalUsd: 612.4, refundable: false, sourceUrl: 'https://www.google.com/travel/flights/example',
  };

  beforeEach(async () => {
    world.cleanup();
    world = createTraceWorld(orderFingerprint(webRequirements)); // mandate bound to the web run's confirmed requirements
    const rail = await setupRail('offline', 'test-web');
    traceId = world.service.start('armaan', 'JFK to SFO Oct 16-18, nonstop, $700 max');
    world.service.confirm(traceId, webRequirements);
    const page = async () => ({ status: 200, text: `<html><body>${'JetBlue nonstop New York to San Francisco. '.repeat(10)} B6 415 and B6 416, round trip $612.40</body></html>` });
    server = new ScripToolServer(world.service, new Map([[traceId, { traceId, agent: world.agent, mandateId: world.mandateId, rail, flights: 'web', webOffers: new Map() }]]), () => {}, page);
  });

  it('offers no catalog search, only the tools to state, request, and pay', async () => {
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, traceId);
    expect((list as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(['state_understanding', 'request_purchase', 'pay']);
    expect((await call('search_flights', { from: 'JFK', to: 'SFO' })).isError).toBe(true);
  });

  it('approves and pays for a real nonstop the agent found, by the id Scrip assigned', async () => {
    const requested = await call('request_purchase', nonstop);
    expect(requested.text).toMatch(/"approved":true/);
    expect(requested.text).toMatch(/web-1/);
    expect((await call('pay', { offerId: 'web-1' })).text).toMatch(/COMPLETED/);
    expect(world.service.hasApprovedPayment(traceId)).toBe(true);
    const check = world.service.events(traceId).find(e => e.type === 'source_checked');
    expect(check?.type === 'source_checked' && check.data.status).toBe('backed');
  });

  it('refuses a one-stop flight and rejects a submission with no source page', async () => {
    const oneStop = { ...nonstop, totalUsd: 420, outbound: [leg('UA 1', 'JFK', 'DEN', '2026-10-16'), leg('UA 2', 'DEN', 'SFO', '2026-10-16')] };
    expect((await call('request_purchase', oneStop)).text).toMatch(/refused/i);
    expect((await call('request_purchase', { ...nonstop, sourceUrl: '' })).isError).toBe(true);
    expect((await call('pay', { offerId: 'web-1' })).isError).toBe(true);
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
