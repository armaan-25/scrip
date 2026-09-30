import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScripToolServer, type RunContext } from '../src/agent/tool-server.js';
import { confirmedRequirements, demoRequest } from '../src/flights/fixtures.js';
import { setupRail } from '../src/rails/rail-setup.js';
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
