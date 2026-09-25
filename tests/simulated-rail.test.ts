import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardPaymentCapabilityProvider } from '../src/cards/card-payments.js';
import { purchaseDigest } from '../src/cards/card-gate.js';
import { SimulatedAcceptMerchant, SimulatedIssuer, SimulatedWebMerchant } from '../src/cards/simulated-rail.js';
import { loadConfig } from '../src/config.js';
import { SqliteMissionStore } from '../src/missions/mission-store.js';
import { PurchaseMissionService } from '../src/missions/purchase-mission-service.js';
import type { ContractInput, ExecutionProvider, HotelBooking } from '../src/missions/types.js';

const booking: HotelBooking = {
  quoteId: 'Q-1', merchant: 'hotel.example', hotelName: 'Harborview Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4.5,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline.',
};
const terms: ContractInput = {
  goal: 'Book', category: 'travel', currency: 'USD', maximumTotal: 550,
  hardConstraints: [{ type: 'date_range', startsOn: booking.startsOn, endsOn: booking.endsOn }], preferences: [], unresolvedHardConstraints: [],
  expiresAt: '2099-09-15T12:00:00-04:00', approvalPolicy: 'confirm_exact_purchase', purchase: booking,
  successConditions: ['booking_matches_contract', 'payment_captured'],
  recoveryPolicy: { allowMerchantCancellation: true, allowMerchantRefundRequest: true, allowReplacement: false, allowRebooking: false, disputeRequiresConfirmation: true },
};
const now = () => new Date('2099-06-01T00:00:00Z');
const DESC = 'HARBORVIEW HOTEL';

function issuedBinding(issuer: SimulatedIssuer) {
  return issuer.issue({
    operationKey: 'op-1', merchantId: 'hotel.example', purchaseDigest: purchaseDigest(booking), merchantDescriptors: [DESC], ceiling: 550, exactTotal: 500,
    currency: 'USD', notBefore: '2099-01-01T00:00:00Z', expiresAt: '2099-09-15T00:00:00Z', singleUse: true,
  });
}

describe('SIMULATED issuer', () => {
  it('a card is single use: the second authorization is declined as used', () => {
    const issuer = new SimulatedIssuer(now);
    const card = issuedBinding(issuer);
    const request = { cardRef: card.cardRef, merchantDescriptor: DESC, mcc: '7011', amount: 500, currency: 'USD' as const, occurredAt: now().toISOString() };
    expect(issuer.authorize(request).approved).toBe(true);
    const second = issuer.authorize(request);
    expect(second.approved).toBe(false);
    if (!second.approved) expect(second.reasons).toEqual(['Card is used']);
  });
  it('a declined authorization produces no payment fact', () => {
    const issuer = new SimulatedIssuer(now);
    const card = issuedBinding(issuer);
    issuer.authorize({ cardRef: card.cardRef, merchantDescriptor: 'OTHER', mcc: '7011', amount: 500, currency: 'USD', occurredAt: now().toISOString() });
    expect(issuer.facts('op-1')).toEqual([]);
    expect(issuer.decisions('op-1')).toHaveLength(1);
  });
  it('freeze makes a later authorization decline', () => {
    const issuer = new SimulatedIssuer(now);
    const card = issuedBinding(issuer);
    issuer.freeze(card.cardRef);
    const d = issuer.authorize({ cardRef: card.cardRef, merchantDescriptor: DESC, mcc: '7011', amount: 500, currency: 'USD', occurredAt: now().toISOString() });
    if (d.approved) throw new Error('expected decline');
    expect(d.reasons).toEqual(['Card is frozen']);
  });
  it('capture then refund produce two facts on the same transaction', () => {
    const issuer = new SimulatedIssuer(now);
    const card = issuedBinding(issuer);
    const d = issuer.authorize({ cardRef: card.cardRef, merchantDescriptor: DESC, mcc: '7011', amount: 500, currency: 'USD', occurredAt: now().toISOString() });
    if (!d.approved) throw new Error('expected approve');
    const captured = issuer.capture(d.authRef);
    const refunded = issuer.refund(d.authRef, 500);
    expect(captured.kind).toBe('captured');
    expect(refunded.kind).toBe('refunded');
    expect(refunded.transactionRef).toBe(captured.transactionRef);
    expect(issuer.facts('op-1')).toHaveLength(2);
  });
  it('the integrated merchant is declined at the order tier for drifted dates; the web merchant is not', () => {
    const issuer = new SimulatedIssuer(now);
    const accept = new SimulatedAcceptMerchant(issuer, { merchantId: 'hotel.example', descriptor: DESC, mcc: '7011', sharedKey: 'k' }, now);
    const web = new SimulatedWebMerchant(issuer, { merchantId: 'hotel.example', descriptor: DESC, mcc: '7011' }, now);
    const drifted = { ...booking, startsOn: '2099-09-19', endsOn: '2099-09-21' };
    const a = accept.checkout(issuedBinding(issuer).cardRef, drifted);
    expect(a.decision.approved).toBe(false);
    expect(a.decision.tier).toBe('order');
    expect(a.evidence).toBeUndefined();
    const w = web.checkout(issuedBinding(issuer).cardRef, drifted);
    expect(w.decision.approved).toBe(true);
    expect(w.decision.tier).toBe('authorization');
    expect(w.evidence?.source).toBe('email');
    expect(w.evidence?.booking.startsOn).toBe('2099-09-19');
  });
});

describe('card bound to the approved purchase through the mission service', () => {
  let directory: string;
  let store: SqliteMissionStore;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-rail-')); store = new SqliteMissionStore(path.join(directory, 'm.sqlite')); });
  afterEach(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it("the issued card's fingerprint equals the mission's approved purchase, and the agent cannot substitute it", async () => {
    const issuer = new SimulatedIssuer(now);
    const provider = new CardPaymentCapabilityProvider(issuer, () => [DESC], now);
    const config = loadConfig('scrip.yaml');
    config.budgets.research.maxTaskAllowance = 550; config.budgets.research.monthlyLimit = 10000;
    const execution: ExecutionProvider = { start: async r => ({ executionRef: r.capabilityRef }), getEvidence: async () => [], stop: async () => {} };
    const service = new PurchaseMissionService(store, config, 'research', execution, provider, now);
    const mission = await service.create('c', terms);
    const rendered = service.renderApproval('c', mission.missionId);
    await service.approve('c', mission.missionId, { channel: 'web', contractVersion: 1, renderedSummaryHash: rendered.hash });
    // Substitution attempt: same price, different dates. Refused before a card exists.
    await expect(service.execute('c', mission.missionId, { ...booking, startsOn: '2099-09-19', endsOn: '2099-09-21' }))
      .rejects.toThrow(/date_range/);
    expect(provider.cardFor(service.get('c', mission.missionId).operation?.key ?? '')).toBeUndefined();
    await service.execute('c', mission.missionId, booking);
    const key = service.get('c', mission.missionId).operation!.key;
    const card = issuer.binding(provider.cardFor(key)!)!;
    expect(card.purchaseDigest).toBe(purchaseDigest(service.get('c', mission.missionId).contract.purchase));
    expect(card.ceiling).toBe(550);
    expect(card.exactTotal).toBe(500);
  });
});
