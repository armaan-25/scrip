import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmedRequirements, demoRequest, layoverOffer, nonstopOffer } from '../src/flights/fixtures.js';
import { FakeNatural } from '../src/rails/fake-natural.js';
import { NaturalHoldConnector } from '../src/rails/natural-hold-connector.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
import { createTraceWorld, type TraceWorld } from './helpers/trace-world.js';

let world: TraceWorld;
let natural: FakeNatural;
let connector: NaturalHoldConnector;
const AGENT = 'agt_flight';

beforeEach(() => {
  world = createTraceWorld();
  natural = new FakeNatural();
  natural.limitCents = 1;
  connector = new NaturalHoldConnector(natural, world.service);
});
afterEach(() => world.cleanup());

async function approvedTrace(): Promise<string> {
  const { service, agent, mandateId } = world;
  const traceId = service.start('armaan', demoRequest);
  service.confirm(traceId, confirmedRequirements);
  service.recordInterpretation(traceId, agent, { ...confirmedRequirements });
  const decision = await service.proposePurchase(traceId, agent, mandateId, nonstopOffer, AGENT);
  if (!decision.approved) throw new Error('fixture should be approved');
  return traceId;
}

async function agentPays(traceId: string, offer = nonstopOffer, agentId = AGENT, amountCents = offer.totalCents) {
  return natural.agent(agentId).pay({
    amountCents, recipient: 'seller', description: 'flight', instanceId: 'run-1',
    tags: { scrip_trace_id: traceId, scrip_order_fp: orderFingerprint(offer) },
  });
}

describe('NaturalHoldConnector', () => {
  it('approves a held payment whose fingerprint, amount and agent match', async () => {
    const traceId = await approvedTrace();
    const payment = await agentPays(traceId);
    expect(payment.status).toBe('IN_REVIEW');
    const result = await connector.pollOnce();
    expect(result.approved).toHaveLength(1);
    expect(await natural.getPaymentStatus(payment.paymentId)).toBe('COMPLETED');
    expect(world.service.hasApprovedPayment(traceId)).toBe(true);
  });

  it('denies when the paid-for order is a different flight', async () => {
    const traceId = await approvedTrace();
    const payment = await agentPays(traceId, layoverOffer, AGENT, nonstopOffer.totalCents);
    const result = await connector.pollOnce();
    expect(result.denied).toHaveLength(1);
    expect(await natural.getPaymentStatus(payment.paymentId)).toBe('APPROVAL_DENIED');
    const decided = world.service.events(traceId).find(e => e.type === 'hold_decided');
    if (decided?.type !== 'hold_decided') throw new Error('missing hold_decided');
    expect(decided.data.reasons.join(' ')).toMatch(/does not match/);
  });

  it('denies the right fingerprint at the wrong amount', async () => {
    const traceId = await approvedTrace();
    await agentPays(traceId, nonstopOffer, AGENT, 59900);
    expect((await connector.pollOnce()).denied).toHaveLength(1);
  });

  it('denies a payment from a different agent', async () => {
    const traceId = await approvedTrace();
    await agentPays(traceId, nonstopOffer, 'agt_other');
    expect((await connector.pollOnce()).denied).toHaveLength(1);
  });

  it('denies a tagged payment whose trace does not exist, without recording anything', async () => {
    await agentPays('trc_unknown');
    const result = await connector.pollOnce();
    expect(result.denied).toHaveLength(1);
    expect(world.service.exists('trc_unknown')).toBe(false);
  });

  it('leaves untagged holds alone (not ours to decide)', async () => {
    const payment = await natural.agent(AGENT).pay({ amountCents: 500, recipient: 'x', description: 'someone else', tags: {}, instanceId: 'r' });
    const result = await connector.pollOnce();
    expect(result.skipped).toEqual([expect.any(String)]);
    expect(await natural.getPaymentStatus(payment.paymentId)).toBe('IN_REVIEW');
  });

  it('denies a second payment for an already-paid purchase', async () => {
    const traceId = await approvedTrace();
    await agentPays(traceId);
    await connector.pollOnce();
    await agentPays(traceId);
    expect((await connector.pollOnce()).denied).toHaveLength(1);
  });

  it('never records a decision when Natural errors, and retries next poll', async () => {
    const traceId = await approvedTrace();
    const payment = await agentPays(traceId);
    natural.failNextApprove = true;
    const first = await connector.pollOnce();
    expect(first.errors).toHaveLength(1);
    expect(world.service.events(traceId).some(e => e.type === 'hold_decided')).toBe(false);
    expect(await natural.getPaymentStatus(payment.paymentId)).toBe('IN_REVIEW');
    const second = await connector.pollOnce();
    expect(second.approved).toHaveLength(1);
  });

  it('is idempotent across repeated polls', async () => {
    const traceId = await approvedTrace();
    await agentPays(traceId);
    await connector.pollOnce();
    const again = await connector.pollOnce();
    expect(again).toEqual({ approved: [], denied: [], skipped: [], errors: [] });
    expect(world.service.events(traceId).filter(e => e.type === 'hold_decided')).toHaveLength(1);
  });

  it('refuses an agent approving its own hold', async () => {
    const traceId = await approvedTrace();
    await agentPays(traceId);
    const [hold] = await natural.listPendingHolds();
    if (!hold) throw new Error('expected a hold');
    await expect(natural.agent(AGENT).approveHold(hold.approvalId)).rejects.toMatchObject({ status: 403 });
  });
  it('does not approve a second payment when an approve response was lost', async () => {
    const traceId = await approvedTrace();
    const first = await agentPays(traceId);
    natural.loseNextApproveResponse = true; // Natural applies the approve, but the reply never arrives
    const lost = await connector.pollOnce();
    expect(lost.errors).toHaveLength(1);
    expect(await natural.getPaymentStatus(first.paymentId)).toBe('COMPLETED');
    const second = await agentPays(traceId);
    const result = await connector.pollOnce();
    expect(result.denied).toHaveLength(1);
    expect(await natural.getPaymentStatus(second.paymentId)).toBe('APPROVAL_DENIED');
  });

  it('reports a failure to list holds as an error instead of throwing', async () => {
    natural.failNextList = true;
    const result = await connector.pollOnce();
    expect(result.errors).toHaveLength(1);
    expect(result.approved).toEqual([]);
  });
});
