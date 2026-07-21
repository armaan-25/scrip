import { describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '../src/ramp-oauth.js';
import { Meter } from '../src/meter.js';
import type { TaskReceipt } from '../src/store.js';

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  baseUrl: 'https://demo-api.ramp.com',
  source: 'scrip',
};

function fakeFetch(tokenBody: object, capture: { body?: unknown; url?: string; headers?: unknown } = {}): HttpFetch {
  return vi.fn(async (url, init) => {
    const href = url.toString();
    if (href.includes('/token')) {
      return { ok: true, status: 200, json: async () => tokenBody } as Response;
    }
    capture.url = href;
    capture.headers = init?.headers;
    capture.body = init?.body ? JSON.parse(init.body as string) : undefined;
    return { ok: true, status: 204, json: async () => ({}) } as Response;
  }) as unknown as HttpFetch;
}

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    receiptId: 'receipt-1',
    authorizationId: 'auth-1',
    rampEntityId: 'ramp-entity-demo',
    rampBudgetId: 'ramp-budget-research',
    team: 'agent-platform',
    taskId: 'task-1',
    task: 'Review code',
    authorized: 2,
    actual: 0.5,
    returned: 1.5,
    childAgents: 1,
    requestCount: 2,
    modelUsage: [
      { model: 'claude-sonnet-5', requests: 1, inputTokens: 100, outputTokens: 50, cost: 0.3 },
      { model: 'claude-haiku-4-5-20251001', requests: 1, inputTokens: 80, outputTokens: 40, cost: 0.2 },
    ],
    costCenter: 'AI compute',
    startedAt: '2026-07-21T10:00:00.000Z',
    settledAt: '2026-07-21T10:05:00.000Z',
    outcome: 'success',
    ...overrides,
  };
}

describe('Meter', () => {
  it('sends one event per model to ai-usage/unified with a Bearer token', async () => {
    const capture: { body?: unknown; url?: string; headers?: unknown } = {};
    const fetchFn = fakeFetch({ access_token: 'token-abc', expires_in: 3600 }, capture);
    const meter = new Meter(config, fetchFn);

    await meter.reportUsage(receipt());

    expect(capture.url).toBe('https://demo-api.ramp.com/developer/v1/ai-usage/unified');
    expect((capture.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');

    const body = capture.body as { schema_version: string; events: any[] };
    expect(body.schema_version).toBe('1.0');
    expect(body.events).toHaveLength(2);

    const sonnetEvent = body.events.find((e) => e.model === 'claude-sonnet-5');
    expect(sonnetEvent).toMatchObject({
      event_id: 'receipt-1:claude-sonnet-5',
      source: 'scrip',
      occurred_at: '2026-07-21T10:05:00.000Z',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 50 },
      attribution: {
        session_id: 'auth-1',
        tags: {
          team: 'agent-platform',
          rampBudgetId: 'ramp-budget-research',
          taskId: 'task-1',
          costCenter: 'AI compute',
          childAgents: '1',
        },
      },
    });
    expect(sonnetEvent.reported_cost).toMatchObject({ amount: '0.3', currency: 'USD', estimated: false });
  });

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      if (url.toString().includes('/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'token-abc', expires_in: 3600 }) } as Response;
      }
      return { ok: false, status: 422, json: async () => ({ error: 'invalid_event' }) } as Response;
    }) as unknown as HttpFetch;
    const meter = new Meter(config, fetchFn);

    await expect(meter.reportUsage(receipt())).rejects.toThrow(/422/);
  });
});
