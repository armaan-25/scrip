import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ScripConfig } from '../src/config.js';
import { TaskAuthorizationManager } from '../src/lease.js';
import { MissionConflictError, SqliteMissionStore } from '../src/missions/mission-store.js';
import { PurchaseMissionService } from '../src/missions/purchase-mission-service.js';
import type {
  BookingEvidence, ContractInput, ExecutionProvider, ExecutionRequest, HotelBooking,
  PaymentCapabilityProvider, PaymentFact, PurchaseMission,
} from '../src/missions/types.js';

const booking: HotelBooking = {
  quoteId: 'quote-1', merchant: 'hotel.example', hotelName: 'Boston Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline; no cancellation fee.',
};
const terms: ContractInput = {
  goal: 'Book a refundable Boston hotel', category: 'travel', currency: 'USD', maximumTotal: 550,
  hardConstraints: [
    { type: 'amount_at_most', amount: 550 }, { type: 'merchant_in', merchants: ['hotel.example'] },
    { type: 'date_range', startsOn: booking.startsOn, endsOn: booking.endsOn },
    { type: 'refundable_until', timestamp: booking.refundableUntil },
    { type: 'rating_at_least', value: 4, scale: 5 }, { type: 'text_match', field: 'city', expected: 'Boston' },
  ],
  preferences: [], unresolvedHardConstraints: [], expiresAt: '2099-09-15T12:00:00-04:00',
  approvalPolicy: 'confirm_exact_purchase', purchase: booking,
  successConditions: ['booking_matches_contract', 'payment_captured'],
  recoveryPolicy: {
    allowMerchantCancellation: true, allowMerchantRefundRequest: true, allowReplacement: false,
    allowRebooking: false, disputeRequiresConfirmation: true,
  },
};

class FakeHotel {
  mode: 'success' | 'failed' | 'timeout' | 'unpaid' | 'narrative' = 'success';
  facts = new Map<string, PaymentFact[]>();
  evidence = new Map<string, BookingEvidence[]>();
  hidden = false;
  effects = 0;
  beforeIssue?: (request: Omit<ExecutionRequest, 'capabilityRef'>) => Promise<void>;
  beforeStart?: () => Promise<void>;
  revoked = new Set<string>();
  execution: ExecutionProvider = {
    start: vi.fn(async request => {
      await this.beforeStart?.();
      if (this.revoked.has(request.operationKey)) throw new Error('Revoked capability');
      if (this.mode === 'unpaid') {
        this.facts.set(request.operationKey, [this.fact(request.operationKey, 'unpaid', 0)]);
        throw new Error('Definitively declined');
      }
      this.effects++;
      if (this.mode !== 'narrative') {
        this.facts.set(request.operationKey, [this.fact(request.operationKey, 'captured', request.booking.total)]);
        this.evidence.set(request.operationKey, [{
          source: 'merchant', externalId: `booking:${request.operationKey}`, operationKey: request.operationKey,
          bookingRef: 'reservation-1', status: this.mode === 'failed' ? 'failed' : 'confirmed',
          booking: structuredClone(request.booking), type: 'hotel_confirmation', description: 'Merchant API confirmation',
          verifiedAt: new Date().toISOString(),
        }]);
      }
      if (this.mode === 'timeout') { this.hidden = true; throw new Error('Timed out after checkout'); }
      return { executionRef: `execution:${request.operationKey}`, narrative: 'I booked the hotel successfully!' };
    }),
    getEvidence: vi.fn(async key => this.hidden ? [] : structuredClone(this.evidence.get(key) ?? [])),
    stop: vi.fn(async key => { this.revoked.add(key); }),
  };
  payments: PaymentCapabilityProvider = {
    issue: vi.fn(async request => {
      await this.beforeIssue?.(request);
      return { capabilityRef: `fake-capability:${request.operationKey}` };
    }),
    getFacts: vi.fn(async key => this.hidden ? [] : structuredClone(this.facts.get(key) ?? [])),
    revoke: vi.fn(async key => { this.revoked.add(key); }),
    requestRecovery: vi.fn(async request => ({ externalId: `ack:${request.recoveryKey}` })),
  };
  fact(key: string, kind: PaymentFact['kind'], amount: number, id: string = kind): PaymentFact {
    return { externalId: `${id}:${key}`, operationKey: key, transactionRef: `tx:${key}`, kind, amount, currency: 'USD', merchant: booking.merchant };
  }
}

let directory: string;
let filename: string;
let stores: SqliteMissionStore[];
let store: SqliteMissionStore;
let service: PurchaseMissionService;
let fake: FakeHotel;
let config: ScripConfig;
function open(): SqliteMissionStore {
  const opened = new SqliteMissionStore(filename);
  stores.push(opened);
  return opened;
}
function compose(opened = store): PurchaseMissionService {
  return new PurchaseMissionService(opened, config, 'research', fake.execution, fake.payments);
}
async function approved(input = terms): Promise<PurchaseMission> {
  const mission = await service.create('consumer-1', structuredClone(input));
  const rendered = service.renderApproval('consumer-1', mission.missionId);
  return service.approve('consumer-1', mission.missionId, {
    channel: 'web', contractVersion: rendered.contractVersion, renderedSummaryHash: rendered.hash,
  });
}
async function execute(): Promise<PurchaseMission> {
  const mission = await approved();
  return service.execute('consumer-1', mission.missionId, booking);
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-mission-'));
  filename = path.join(directory, 'missions.sqlite'); stores = []; store = open(); fake = new FakeHotel();
  config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 550; config.budgets.research.monthlyLimit = 10000;
  service = compose();
});
afterEach(() => {
  for (const item of stores) item.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('refundable hotel mission', () => {
  it('drafts have no spending authority and cannot self-approve by supplying metadata', async () => {
    const mission = await service.create('consumer-1', structuredClone(terms));
    expect(mission.status).toBe('draft');
    expect(mission.authorizationId).toBeUndefined();
    await expect(service.execute('consumer-1', mission.missionId, booking)).rejects.toThrow(/approval/);
    expect(fake.payments.issue).not.toHaveBeenCalled();
    expect((await service.getReceipt('consumer-1', mission.missionId)).authorized).toBe(0);
    await expect(service.create('consumer-1', { ...terms, approvalEvidence: {} } as ContractInput)).rejects.toThrow();
  });

  it('binds approval to exact rendered terms/version and preserves immutable historical versions', async () => {
    const mission = await approved();
    expect(mission.contract.approvalEvidence?.approvedBy).toBe('consumer-1');
    expect(service.renderApproval('consumer-1', mission.missionId).summary).toContain(booking.cancellationTerms);
    await expect(service.approve('consumer-1', mission.missionId, {
      channel: 'web', contractVersion: 1, renderedSummaryHash: 'wrong',
    })).rejects.toThrow(/hash/);
    const changed = { ...terms, purchase: { ...booking, total: 510 } };
    const revised = await service.revise('consumer-1', mission.missionId, 1, changed);
    expect(revised.contract.version).toBe(2);
    expect(revised.contract.approvalEvidence).toBeUndefined();
    expect(revised.contracts[0].approvalEvidence).toEqual(mission.contract.approvalEvidence);
    mission.contract.purchase.total = 1;
    expect(service.get('consumer-1', mission.missionId).contracts[0].purchase.total).toBe(500);
    await expect(service.approve('consumer-1', mission.missionId, {
      channel: 'web', contractVersion: 1, renderedSummaryHash: revised.contracts[0].approvalEvidence!.renderedSummaryHash,
    })).rejects.toThrow(/version/);
    await expect(service.execute('consumer-1', mission.missionId, changed.purchase)).rejects.toThrow(/approval/);
  });

  it.each([
    { merchant: 'wrong.example' }, { total: 551 }, { total: 499 }, { startsOn: '2099-09-19' },
    { endsOn: '2099-09-21' }, { refundableUntil: '2099-09-14T00:00:00Z' },
    { cancellationTerms: 'No refund' }, { city: 'Chicago' }, { rating: 3 }, { roomType: 'Single' },
    { currency: 'EUR' }, { total: NaN },
  ])('blocks a changed candidate before any provider call: %j', async change => {
    const mission = await approved();
    await expect(service.execute('consumer-1', mission.missionId, { ...booking, ...change } as HotelBooking)).rejects.toThrow();
    expect(fake.payments.issue).not.toHaveBeenCalled();
    expect(fake.execution.start).not.toHaveBeenCalled();
  });

  it.each([
    { hardConstraints: [{ type: 'unimplemented_predicate' }] },
    { unresolvedHardConstraints: ['near downtown'] },
    { hardConstraints: [{ type: 'date_range', startsOn: 'garbage', endsOn: booking.endsOn }] },
    { successConditions: ['payment_captured'] },
  ])('keeps unresolved enforcement in draft: %j', async change => {
    const mission = await service.create('consumer-1', { ...terms, ...change } as ContractInput);
    const rendered = service.renderApproval('consumer-1', mission.missionId);
    await expect(service.approve('consumer-1', mission.missionId, {
      channel: 'web', contractVersion: 1, renderedSummaryHash: rendered.hash,
    })).rejects.toThrow();
    expect(service.get('consumer-1', mission.missionId).status).toBe('draft');
  });

  it('reserves durably before issue or checkout, then settles an evidence-backed receipt', async () => {
    fake.beforeIssue = async request => {
      const persisted = open();
      const receipt = await compose(persisted).getReceipt('consumer-1', request.missionId);
      expect(receipt.reserved).toBe(550);
      expect(receipt.mission.operation?.key).toBe(request.operationKey);
      expect(receipt.events.some(event => event.type === 'execution_started')).toBe(true);
      expect(fake.execution.start).not.toHaveBeenCalled();
    };
    const mission = await execute();
    expect(mission.status).toBe('succeeded');
    const receipt = await service.getReceipt('consumer-1', mission.missionId);
    expect(receipt).toMatchObject({ authorized: 550, reserved: 0, captured: 500, refunded: 0, reversed: 0, returned: 50, unrecovered: 0, netSpend: 500 });
    expect(receipt.taskReceipt).toMatchObject({ actual: 500, returned: 50, outcome: 'success' });
    expect(receipt.taskReceipt?.evidenceDetail).toHaveLength(1);
    expect(receipt.events.find(event => event.type === 'execution_observed')?.source).toBe('execution_provider');
    expect(receipt.events.find(event => event.type === 'booking_observed')?.source).toBe('merchant');
    expect(receipt.events.find(event => event.type === 'payment_observed')?.source).toBe('payment_provider');
  });

  it('retries from another SQLite connection without a second purchase or capture', async () => {
    const mission = await execute();
    const restarted = compose(open());
    await restarted.execute('consumer-1', mission.missionId, booking);
    await restarted.execute('consumer-1', mission.missionId, booking);
    expect(fake.effects).toBe(1);
    expect(fake.payments.issue).toHaveBeenCalledTimes(1);
    expect((await restarted.getReceipt('consumer-1', mission.missionId)).captured).toBe(500);
  });

  it('a simultaneous retry during provider I/O cannot acquire a second purchase operation', async () => {
    const mission = await approved();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    fake.beforeIssue = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
    const first = service.execute('consumer-1', mission.missionId, booking);
    await enteredPromise;
    const second = await compose(open()).execute('consumer-1', mission.missionId, booking);
    expect(second.status).toBe('outcome_pending');
    expect(fake.payments.issue).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe('succeeded');
    expect(fake.effects).toBe(1);
  });

  it('retains ambiguous reservations across restart and only reconciles the original payment', async () => {
    fake.mode = 'timeout';
    const mission = await execute();
    expect(mission.status).toBe('outcome_pending');
    expect((await service.getReceipt('consumer-1', mission.missionId)).reserved).toBe(550);
    const restarted = compose(open());
    await restarted.execute('consumer-1', mission.missionId, booking);
    expect(fake.effects).toBe(1);
    expect(fake.payments.issue).toHaveBeenCalledTimes(1);
    fake.hidden = false;
    expect((await restarted.execute('consumer-1', mission.missionId, booking)).status).toBe('succeeded');
    expect((await restarted.getReceipt('consumer-1', mission.missionId)).reserved).toBe(0);
  });

  it('cancels a reservation only on authoritative unpaid evidence', async () => {
    fake.mode = 'unpaid';
    const mission = await execute();
    expect((await service.getReceipt('consumer-1', mission.missionId))).toMatchObject({ captured: 0, reserved: 0, returned: 550 });
    await service.execute('consumer-1', mission.missionId, booking);
    expect(fake.execution.start).toHaveBeenCalledTimes(1);
  });

  it('does not let the executing agent self-certify success', async () => {
    fake.mode = 'narrative';
    const mission = await execute();
    expect(mission.status).toBe('outcome_pending');
    expect((await service.verify('consumer-1', mission.missionId)).status).toBe('pending');
    await expect(service.recordBookingEvidence('consumer-1', mission.missionId, {
      source: 'execution_provider', description: 'I succeeded',
    } as unknown as BookingEvidence)).rejects.toThrow();
  });

  it('conflicting independent evidence yields unknown even after earlier success', async () => {
    const mission = await execute();
    const evidence = fake.evidence.get(mission.operation!.key)![0];
    await service.recordBookingEvidence('consumer-1', mission.missionId, {
      ...evidence, source: 'email', externalId: 'contradictory-email', status: 'failed',
    });
    expect((await service.verify('consumer-1', mission.missionId)).status).toBe('unknown');
    expect(service.get('consumer-1', mission.missionId).status).toBe('outcome_pending');
  });

  it('runs failed booking → permitted recovery → acknowledgment → partial and full posted refunds', async () => {
    fake.mode = 'failed';
    const mission = await execute();
    expect(mission.status).toBe('recovery_required');
    expect((await service.getReceipt('consumer-1', mission.missionId)).unrecovered).toBe(500);
    await service.requestRecovery('consumer-1', mission.missionId, 'refund');
    await service.requestRecovery('consumer-1', mission.missionId, 'refund');
    expect(fake.payments.requestRecovery).toHaveBeenCalledTimes(1);
    expect((await service.getReceipt('consumer-1', mission.missionId))).toMatchObject({
      captured: 500, refunded: 0, refundPending: true, unrecovered: 500, returned: 50,
    });
    const key = mission.operation!.key;
    const partial = fake.fact(key, 'refunded', 200, 'refund-first');
    await service.recordPaymentFact('consumer-1', mission.missionId, partial);
    await service.recordPaymentFact('consumer-1', mission.missionId, partial);
    expect((await service.getReceipt('consumer-1', mission.missionId))).toMatchObject({
      captured: 500, refunded: 200, unrecovered: 300, refundPending: true, mission: { status: 'partially_recovered' },
    });
    await service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(key, 'refunded', 300, 'refund-second'));
    const receipt = await service.getReceipt('consumer-1', mission.missionId);
    expect(receipt).toMatchObject({
      authorized: 550, captured: 500, refunded: 500, reserved: 0, returned: 50, unrecovered: 0, refundPending: false,
      mission: { status: 'refunded' },
    });
    expect(receipt.events.filter(event => event.type === 'payment_observed' && event.data.kind === 'captured')).toHaveLength(1);
    expect(receipt.events.filter(event => event.type === 'payment_observed' && event.data.kind === 'refunded')).toHaveLength(2);
  });

  it('keeps a provider refund acknowledgment distinct from posted credits', async () => {
    const mission = await execute();
    await service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(mission.operation!.key, 'refund_acknowledged', 500));
    const receipt = await service.getReceipt('consumer-1', mission.missionId);
    expect(receipt).toMatchObject({ refundPending: true, refunded: 0, captured: 500, unrecovered: 500, mission: { status: 'recovering' } });
  });

  it('preserves reversals separately from captures and refunds', async () => {
    const mission = await execute();
    await service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(mission.operation!.key, 'reversed', 500));
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ captured: 500, reversed: 500, refunded: 0, netSpend: 0, returned: 50 });
  });

  it.each([
    { amount: -1 }, { amount: Infinity }, { amount: 500.001 }, { amount: 551 },
    { operationKey: 'other-operation' }, { merchant: 'other-merchant' }, { currency: 'EUR' },
  ])('rejects malformed or misbound payment facts without releasing an ambiguous hold: %j', async change => {
    fake.mode = 'timeout';
    const mission = await execute();
    const fact = fake.fact(mission.operation!.key, 'captured', 500);
    await expect(service.recordPaymentFact('consumer-1', mission.missionId, { ...fact, ...change } as PaymentFact)).rejects.toThrow();
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ reserved: 550, captured: 0 });
  });

  it('rejects event-ID reuse, a second capture, and a refund exceeding captured funds', async () => {
    const mission = await execute();
    const key = mission.operation!.key;
    await expect(service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(key, 'captured', 499))).rejects.toThrow(/Conflicting/);
    await expect(service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(key, 'captured', 500, 'another-capture'))).rejects.toThrow(/Conflicting/);
    await expect(service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(key, 'refunded', 501))).rejects.toThrow(/exceeds/);
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ captured: 500, refunded: 0 });
  });

  it('records a lower authoritative capture but fails the exact-price outcome check', async () => {
    fake.mode = 'timeout';
    const mission = await execute();
    await service.recordPaymentFact('consumer-1', mission.missionId, fake.fact(mission.operation!.key, 'captured', 490));
    await service.recordBookingEvidence('consumer-1', mission.missionId, fake.evidence.get(mission.operation!.key)![0]);
    expect((await service.verify('consumer-1', mission.missionId)).status).toBe('failure');
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ captured: 490, returned: 60, unrecovered: 490 });
  });

  it('refuses expired approval and a material revision after execution starts', async () => {
    const expired = await service.create('consumer-1', { ...terms, expiresAt: '2020-01-01T00:00:00Z' });
    const rendered = service.renderApproval('consumer-1', expired.missionId);
    await expect(service.approve('consumer-1', expired.missionId, {
      channel: 'web', contractVersion: 1, renderedSummaryHash: rendered.hash,
    })).rejects.toThrow(/expired/);
    fake.mode = 'timeout';
    const mission = await execute();
    await expect(service.revise('consumer-1', mission.missionId, 1, terms)).rejects.toThrow(/separate mission/);
  });

  it('uses the existing shared budget when two missions compete for remaining funds', async () => {
    config.budgets.research.monthlyLimit = 550;
    fake.mode = 'timeout';
    await execute();
    const next = await approved();
    await expect(compose(open()).execute('consumer-1', next.missionId, booking)).rejects.toThrow(/remains/);
    expect(fake.payments.issue).toHaveBeenCalledTimes(1);
  });

  it('settled local receipts continue to count against the shared budget', async () => {
    config.budgets.research.monthlyLimit = 1000;
    await execute();
    const next = await approved();
    await expect(compose(open()).execute('consumer-1', next.missionId, booking)).rejects.toThrow(/remains/);
  });

  it('revocation cannot make unknown holds or later captures available to other missions', async () => {
    config.budgets.research.monthlyLimit = 550;
    fake.mode = 'timeout';
    const mission = await execute();
    await service.cancel('consumer-1', mission.missionId);
    const next = await approved();
    await expect(compose(open()).execute('consumer-1', next.missionId, booking)).rejects.toThrow(/remains/);
    fake.hidden = false;
    await service.reconcile('consumer-1', mission.missionId);
    await expect(compose(open()).execute('consumer-1', next.missionId, booking)).rejects.toThrow(/remains/);
    expect(fake.effects).toBe(1);
  });

  it('rolls back authoritative payment evidence when lease commit fails', async () => {
    fake.mode = 'timeout';
    const mission = await execute();
    const spy = vi.spyOn(TaskAuthorizationManager.prototype, 'commitAction').mockImplementationOnce(() => { throw new Error('Commit interrupted'); });
    const fact = fake.fact(mission.operation!.key, 'captured', 500);
    await expect(service.recordPaymentFact('consumer-1', mission.missionId, fact)).rejects.toThrow(/interrupted/);
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ reserved: 550, captured: 0 });
    spy.mockRestore();
    await compose(open()).recordPaymentFact('consumer-1', mission.missionId, fact);
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ reserved: 0, captured: 500 });
  });

  it('retries an ambiguous recovery only by reconciliation, without a second refund request', async () => {
    fake.mode = 'failed';
    const mission = await execute();
    vi.mocked(fake.payments.requestRecovery).mockRejectedValueOnce(new Error('Refund timeout'));
    await service.requestRecovery('consumer-1', mission.missionId, 'refund');
    await compose(open()).requestRecovery('consumer-1', mission.missionId, 'refund');
    expect(fake.payments.requestRecovery).toHaveBeenCalledTimes(1);
    expect(await service.getReceipt('consumer-1', mission.missionId)).toMatchObject({ refunded: 0, unrecovered: 500, mission: { status: 'recovering' } });
  });

  it('blocks forbidden recovery and all dispute submissions', async () => {
    const mission = await approved({ ...terms, recoveryPolicy: { ...terms.recoveryPolicy, allowMerchantRefundRequest: false } });
    await service.execute('consumer-1', mission.missionId, booking);
    await expect(service.requestRecovery('consumer-1', mission.missionId, 'refund')).rejects.toThrow(/not permitted/);
    await expect(service.requestRecovery('consumer-1', mission.missionId, 'dispute')).rejects.toThrow(/fresh consumer confirmation/);
    await expect(service.requestRecovery('consumer-1', mission.missionId, 'rebook')).rejects.toThrow(/not supported/);
    expect(fake.payments.requestRecovery).not.toHaveBeenCalled();
  });

  it('revokes the root and descendants while preserving an ambiguous hold for later capture', async () => {
    fake.mode = 'timeout';
    const mission = await execute();
    // Use the real lease manager and same transaction boundary to prove the cascade.
    let childCredential = '';
    let authorizationId = '';
    await store.transaction(async () => {
      const manager = new TaskAuthorizationManager(config, {
        getReportedSpend: async () => 0, reportTaskUsage: async () => {},
      }, store.leaseStateStore());
      const root = await manager.authorizeTask({ budget: 'research', taskId: 'cascade-fixture', task: 'cascade', allowance: 10 });
      authorizationId = root.authorization.authorizationId;
      childCredential = manager.delegate(root.credential, 'child', 5).credential;
      const reservation = manager.reserveAction(childCredential, 'purchase', 'pending', 5);
      expect(() => manager.revokeTask(authorizationId)).toThrow(/in flight/);
      manager.revokeTask(authorizationId, { preservePending: true });
      expect(manager.getLeaseTree(authorizationId).every(lease => lease.status === 'revoked')).toBe(true);
      expect(manager.getAuthorization(authorizationId).pending).toBe(5);
      expect(() => manager.reserveAction(childCredential, 'purchase', 'blocked', 1)).toThrow();
      manager.commitAction(reservation.reservationId, 4);
      expect(manager.getAuthorization(authorizationId)).toMatchObject({ spent: 4, pending: 0, status: 'revoked' });
    });
    const oldEvents = store.events(mission.missionId);
    await service.cancel('consumer-1', mission.missionId);
    expect(fake.execution.stop).toHaveBeenCalledWith(mission.operation!.key);
    expect(fake.payments.revoke).toHaveBeenCalledWith(mission.operation!.key);
    expect((await service.getReceipt('consumer-1', mission.missionId))).toMatchObject({ reserved: 550, mission: { revoked: true } });
    expect(store.events(mission.missionId).slice(0, oldEvents.length)).toEqual(oldEvents);
    fake.hidden = false;
    await service.execute('consumer-1', mission.missionId, booking);
    expect(fake.effects).toBe(1);
    expect((await service.getReceipt('consumer-1', mission.missionId))).toMatchObject({ captured: 500, reserved: 0, returned: 50, mission: { revoked: true } });
  });

  it('a revocation between capability issuance and checkout prevents purchase', async () => {
    const mission = await approved();
    fake.beforeIssue = async () => { await compose(open()).cancel('consumer-1', mission.missionId); };
    await service.execute('consumer-1', mission.missionId, booking);
    expect(fake.execution.start).not.toHaveBeenCalled();
    expect(fake.effects).toBe(0);
    expect((await service.getReceipt('consumer-1', mission.missionId)).reserved).toBe(550);
  });

  it('cancelled drafts cannot execute, and every consumer operation checks ownership', async () => {
    const mission = await approved();
    expect(() => service.get('other-consumer', mission.missionId)).toThrow(/belong/);
    await expect(service.execute('other-consumer', mission.missionId, booking)).rejects.toThrow(/belong/);
    await expect(service.cancel('other-consumer', mission.missionId)).rejects.toThrow(/belong/);
    await service.cancel('consumer-1', mission.missionId);
    await expect(service.execute('consumer-1', mission.missionId, booking)).rejects.toThrow(/revoked/);
    expect(fake.payments.issue).not.toHaveBeenCalled();
  });

  it('rolls back operation claims and lease reservations together', async () => {
    const mission = await approved();
    const realAppend = store.append.bind(store);
    const append = vi.spyOn(store, 'append').mockImplementation((id, event, version, now) => {
      if (event.type === 'execution_started') throw new Error('Simulated database failure');
      return realAppend(id, event, version, now);
    });
    await expect(service.execute('consumer-1', mission.missionId, booking)).rejects.toThrow(/database failure/);
    expect(service.get('consumer-1', mission.missionId).operation).toBeUndefined();
    await store.transaction(() => { expect(store.leaseStateStore().load()).toBeUndefined(); });
    expect(fake.payments.issue).not.toHaveBeenCalled();
    append.mockRestore();
    expect((await service.execute('consumer-1', mission.missionId, booking)).status).toBe('succeeded');
  });

  it('enforces optimistic versions and durable operation uniqueness on separate connections', async () => {
    const mission = await approved();
    await store.transaction(() => {
      expect(store.claimOperation('key-a', mission.missionId, 1, 'test')).toBe(true);
    });
    const other = open();
    await other.transaction(() => {
      expect(other.claimOperation('key-a', mission.missionId, 1, 'test')).toBe(false);
      expect(other.claimOperation('different-key', mission.missionId, 1, 'test')).toBe(false);
    });
    await expect(other.transaction(() => other.append(mission.missionId, {
      type: 'mission_revoked', source: 'consumer', data: {},
    }, 0, new Date()))).rejects.toThrow(MissionConflictError);
  });

  it('restores a real process exit at the provider boundary without dispatching again', async () => {
    const mission = await approved();
    const script = `
      import { SqliteMissionStore } from './src/missions/mission-store.ts';
      import { PurchaseMissionService } from './src/missions/purchase-mission-service.ts';
      const [filename, configJson, missionId, bookingJson] = process.argv.slice(1);
      const store = new SqliteMissionStore(filename);
      const execution = { start: async () => { throw new Error('Unexpected checkout'); }, getEvidence: async () => [], stop: async () => {} };
      const payments = { issue: async () => process.exit(42), getFacts: async () => [], revoke: async () => {}, requestRecovery: async () => ({externalId: 'unused'}) };
      await new PurchaseMissionService(store, JSON.parse(configJson), 'research', execution, payments).execute('consumer-1', missionId, JSON.parse(bookingJson));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, filename, JSON.stringify(config), mission.missionId, JSON.stringify(booking)], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(42);
    const restarted = compose(open());
    expect((await restarted.getReceipt('consumer-1', mission.missionId)).reserved).toBe(550);
    expect((await restarted.execute('consumer-1', mission.missionId, booking)).status).toBe('outcome_pending');
    expect(fake.payments.issue).not.toHaveBeenCalled();
    expect(fake.execution.start).not.toHaveBeenCalled();
  });
});
