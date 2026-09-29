import { afterEach, describe, expect, it } from 'vitest';
import { confirmedRequirements, demoRequest, layoverOffer, nonstopOffer } from '../src/flights/fixtures.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
import { renderTimeline } from '../src/trace/timeline.js';
import { createTraceWorld, type TraceWorld } from './helpers/trace-world.js';

let world: TraceWorld;
afterEach(() => world.cleanup());

describe('FlightTraceService', () => {
  it('approves a faithful agent choosing a matching flight and reserves its cost', async () => {
    world = createTraceWorld();
    const { service, agent, mandateId, ledger } = world;
    const traceId = service.start('armaan', demoRequest);
    service.confirm(traceId, confirmedRequirements);
    expect(service.recordInterpretation(traceId, agent, { ...confirmedRequirements })).toEqual([]);

    const decision = await service.proposePurchase(traceId, agent, mandateId, nonstopOffer, 'agt_test');
    expect(decision).toEqual({ approved: true, fingerprint: orderFingerprint(nonstopOffer), totalCents: 55900 });
    expect(service.approvedPurchase(traceId)).toEqual({ fingerprint: orderFingerprint(nonstopOffer), totalCents: 55900, naturalAgentId: 'agt_test' });

    const approved = service.events(traceId).find(e => e.type === 'purchase_approved');
    if (approved?.type !== 'purchase_approved') throw new Error('missing purchase_approved');
    expect(ledger.getAuthorization(approved.data.authorizationId).pending).toBeCloseTo(559);
  });

  it('records a misreading agent and blocks its choice before payment', async () => {
    world = createTraceWorld();
    const { service, agent, mandateId } = world;
    const traceId = service.start('armaan', demoRequest);
    service.confirm(traceId, confirmedRequirements);
    const diffs = service.recordInterpretation(traceId, agent, { ...confirmedRequirements, directOnly: false, refundableOnly: false });
    expect(diffs.map(d => d.field)).toEqual(['directOnly', 'refundableOnly']);

    const decision = await service.proposePurchase(traceId, agent, mandateId, layoverOffer, 'agt_test');
    expect(decision.approved).toBe(false);
    if (decision.approved) throw new Error('unreachable');
    expect(decision.reasons.join(' ')).toMatch(/direct only was required/);
    expect(service.approvedPurchase(traceId)).toBeUndefined();
  });

  it('refuses when the mandate was approved for different requirements', async () => {
    world = createTraceWorld('sha256:someone-elses-requirements');
    const { service, agent, mandateId } = world;
    const traceId = service.start('armaan', demoRequest);
    service.confirm(traceId, confirmedRequirements);
    const decision = await service.proposePurchase(traceId, agent, mandateId, nonstopOffer, 'agt_test');
    expect(decision.approved).toBe(false);
  });

  it('refuses a purchase before requirements are confirmed', async () => {
    world = createTraceWorld();
    const traceId = world.service.start('armaan', demoRequest);
    await expect(world.service.proposePurchase(traceId, world.agent, world.mandateId, nonstopOffer, 'agt_test')).rejects.toThrow(/confirm/);
  });

  it('commits the reserved budget when the payment completes and renders a timeline', async () => {
    world = createTraceWorld();
    const { service, agent, mandateId, ledger } = world;
    const traceId = service.start('armaan', demoRequest);
    service.confirm(traceId, confirmedRequirements);
    service.recordInterpretation(traceId, agent, { ...confirmedRequirements });
    await service.proposePurchase(traceId, agent, mandateId, nonstopOffer, 'agt_test');
    service.recordPaymentSubmitted(traceId, { paymentId: 'pay_1', instanceId: 'run-1', fingerprintTag: orderFingerprint(nonstopOffer), amountCents: 55900 });
    service.recordHold(traceId, { approvalId: 'apr_1', paymentId: 'pay_1', reasons: ['limitExceeded'], senderAgentId: 'agt_test' });
    service.recordDecision(traceId, { approvalId: 'apr_1', paymentId: 'pay_1', decision: 'approved', reasons: [] });
    service.recordSettlement(traceId, { paymentId: 'pay_1', status: 'COMPLETED' });

    const approved = service.events(traceId).find(e => e.type === 'purchase_approved');
    if (approved?.type !== 'purchase_approved') throw new Error('missing purchase_approved');
    const auth = ledger.getAuthorization(approved.data.authorizationId);
    expect(auth.spent).toBeCloseTo(559);
    expect(auth.pending).toBe(0);
    expect(service.hasApprovedPayment(traceId)).toBe(true);

    const lines = renderTimeline(service.events(traceId));
    expect(lines.length).toBe(10);
    expect(lines.join('\n')).toMatch(/Person asked/);
    expect(lines.join('\n')).toMatch(/APPROVED/);
  });
  it('refuses to settle on a non-final status, then commits when the payment really completes', async () => {
    world = createTraceWorld();
    const { service, agent, mandateId, ledger } = world;
    const traceId = service.start('armaan', demoRequest);
    service.confirm(traceId, confirmedRequirements);
    await service.proposePurchase(traceId, agent, mandateId, nonstopOffer, 'agt_test');
    expect(() => service.recordSettlement(traceId, { paymentId: 'pay_1', status: 'IN_REVIEW' })).toThrow(/not final/);
    service.recordSettlement(traceId, { paymentId: 'pay_1', status: 'COMPLETED' });
    const approved = service.events(traceId).find(e => e.type === 'purchase_approved');
    if (approved?.type !== 'purchase_approved') throw new Error('missing purchase_approved');
    expect(ledger.getAuthorization(approved.data.authorizationId).spent).toBeCloseTo(559);
  });
  it('announces each recorded event, in order, to an optional listener', async () => {
    world = createTraceWorld();
    const seen: string[] = [];
    world.service.onEvent = e => seen.push(e.type);
    const traceId = world.service.start('armaan', demoRequest);
    world.service.confirm(traceId, confirmedRequirements);
    world.service.recordInterpretation(traceId, world.agent, { ...confirmedRequirements });
    expect(seen).toEqual(['request_received', 'requirements_confirmed', 'agent_interpretation_recorded', 'interpretation_compared']);
  });
});
