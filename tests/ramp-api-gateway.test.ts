import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '../src/ramp-oauth.js';
import { RampApiGateway } from '../src/ramp-api-gateway.js';
import { Meter } from '../src/meter.js';
import type { TaskReceipt } from '../src/store.js';

let tmpDir: string;
let receiptPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-ramp-api-'));
  receiptPath = path.join(tmpDir, 'ramp.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  baseUrl: 'https://demo-api.ramp.com',
  fundIdsByBudget: { 'ramp-budget-research': 'cd1c33eb-d742-4d7e-850f-972eb3c3c53f' },
};

// Response shape confirmed live against the real sandbox - see docs/ramp-api-notes.md.
function realFundResponse(spentMinorUnits: number) {
  return {
    id: 'cd1c33eb-d742-4d7e-850f-972eb3c3c53f',
    display_name: 'Software',
    state: 'ACTIVE',
    balance: {
      total: { amount: spentMinorUnits, currency_code: 'USD', minor_unit_conversion_rate: 100 },
      cleared: { amount: spentMinorUnits, currency_code: 'USD', minor_unit_conversion_rate: 100 },
      pending: { amount: 0, currency_code: 'USD', minor_unit_conversion_rate: 100 },
    },
    spending_restrictions: {
      limit: { amount: 1000000, currency_code: 'USD', minor_unit_conversion_rate: 100 },
      interval: 'MONTHLY',
    },
  };
}

function fakeFetch(handlers: { token: object; fund: object; fundStatus?: number }): HttpFetch {
  return vi.fn(async (url) => {
    const href = url.toString();
    if (href.includes('/token')) {
      return { ok: true, status: 200, json: async () => handlers.token } as Response;
    }
    return {
      ok: (handlers.fundStatus ?? 200) < 400,
      status: handlers.fundStatus ?? 200,
      json: async () => handlers.fund,
    } as Response;
  }) as unknown as HttpFetch;
}

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    receiptId: 'receipt-1',
    authorizationId: 'auth-1',
    rampEntityId: 'entity-1',
    rampBudgetId: 'ramp-budget-research',
    team: 'agents',
    taskId: 'task-1',
    task: 'Review code',
    authorized: 2,
    actual: 0.5,
    returned: 1.5,
    childAgents: 0,
    workerCount: 0,
    requestCount: 1,
    actionCount: 1,
    modelUsage: [],
    actionUsage: [],
    costs: { inferenceUsd: 0, paidApiUsd: 0, cloudComputeUsd: 0, purchasesUsd: 0, approvalOverheadUsd: 0, otherUsd: 0 },
    costCenter: 'AI compute',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    outcome: 'unknown',
    ...overrides,
  };
}

describe('RampApiGateway', () => {
  it('resolves rampBudgetId to a real Fund ID and converts minor units to dollars', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: realFundResponse(4250), // $42.50
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    const spent = await gateway.getReportedSpend('ramp-budget-research');

    expect(spent).toBeCloseTo(42.5);
    const mockFetch = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const fundCall = mockFetch.mock.calls.find((call: unknown[]) => !String(call[0]).includes('/token'));
    expect((fundCall?.[1] as RequestInit)?.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
    expect(fundCall?.[0]).toBe(
      'https://demo-api.ramp.com/developer/v1/funds/cd1c33eb-d742-4d7e-850f-972eb3c3c53f'
    );
  });

  it('throws when no Fund ID is configured for the requested budget', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: realFundResponse(0),
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await expect(gateway.getReportedSpend('ramp-budget-unknown')).rejects.toThrow(/No Ramp Fund ID configured/);
  });

  it('throws when the Fund request fails, without falling back silently', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: { error: 'not_found' },
      fundStatus: 404,
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await expect(gateway.getReportedSpend('ramp-budget-research')).rejects.toThrow(/404/);
  });

  it('throws when the OAuth exchange fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as unknown as HttpFetch;
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await expect(gateway.getReportedSpend('ramp-budget-research')).rejects.toThrow(/401/);
  });

  it('writes receipts locally rather than to a real Ramp endpoint', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: realFundResponse(0),
    });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);

    await gateway.reportTaskUsage(receipt());

    const persisted = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    expect(persisted.receipts).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads a previously reported receipt back by authorizationId, from the local write - not a Ramp API call', async () => {
    const fetchFn = fakeFetch({ token: { access_token: 'token-abc', expires_in: 3600 }, fund: realFundResponse(0) });
    const gateway = new RampApiGateway(config, receiptPath, fetchFn);
    await gateway.reportTaskUsage(receipt({ authorizationId: 'auth-42' }));

    const found = await gateway.getReceipt('auth-42');
    expect(found?.authorizationId).toBe('auth-42');
    expect(await gateway.getReceipt('not-a-real-auth')).toBeUndefined();
  });

  it('also broadcasts via Meter when one is provided, in addition to the local write', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: realFundResponse(0),
    });
    const meter = new Meter(
      { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: 'https://demo-api.ramp.com', source: 'scrip' },
      fetchFn
    );
    const reportSpy = vi.spyOn(meter, 'reportUsage');
    const gateway = new RampApiGateway(config, receiptPath, fetchFn, meter);

    await gateway.reportTaskUsage(receipt());

    const persisted = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    expect(persisted.receipts).toHaveLength(1);
    expect(reportSpy).toHaveBeenCalledOnce();
  });

  it('swallows a Meter broadcast failure - the local write still succeeds and reportTaskUsage does not throw', async () => {
    const fetchFn = fakeFetch({
      token: { access_token: 'token-abc', expires_in: 3600 },
      fund: realFundResponse(0),
    });
    const meter = new Meter(
      { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: 'https://demo-api.ramp.com', source: 'scrip' },
      fetchFn
    );
    vi.spyOn(meter, 'reportUsage').mockRejectedValue(new Error('broadcast unavailable'));
    const gateway = new RampApiGateway(config, receiptPath, fetchFn, meter);

    await expect(gateway.reportTaskUsage(receipt())).resolves.toBeUndefined();

    const persisted = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    expect(persisted.receipts).toHaveLength(1);
  });
});
