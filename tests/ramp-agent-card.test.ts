import { describe, expect, it, vi } from 'vitest';
import { MockCardIssuer, RampAgentCardIssuer } from '../src/ramp-agent-card.js';
import type { HttpFetch } from '../src/ramp-oauth.js';

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  baseUrl: 'https://demo-api.ramp.com',
  cardholderUserId: 'user-1',
};

const tokenResponse = { access_token: 'token-abc', expires_in: 3600 };

function fakeFetch(responses: unknown[]) {
  let call = 0;
  return vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as HttpFetch & ReturnType<typeof vi.fn>;
}

describe('RampAgentCardIssuer', () => {
  it('mints a card once the deferred task reports success', async () => {
    const fetchFn = fakeFetch([
      tokenResponse,
      { id: 'task-1' },
      { status: 'SUCCESS', card: { id: 'card-1', last4: '4242', state: 'ACTIVE' } },
    ]);
    const issuer = new RampAgentCardIssuer(config, fetchFn);

    const card = await issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' });

    expect(card).toEqual({ cardId: 'card-1', last4: '4242', state: 'ACTIVE' });
    const [, createInit] = fetchFn.mock.calls[1];
    const requestBody = JSON.parse(String(createInit?.body));
    expect(requestBody.user_id).toBe('user-1');
    expect(requestBody.spending_restrictions.amount).toBe(1250);
  });

  it('throws when the deferred task reports an error', async () => {
    const fetchFn = fakeFetch([tokenResponse, { id: 'task-1' }, { status: 'ERROR' }]);
    const issuer = new RampAgentCardIssuer(config, fetchFn);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' })
    ).rejects.toThrow(/failed/);
  });

  it('throws when the create request itself fails', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('grant_type')) {
        return { ok: true, status: 200, json: async () => tokenResponse } as Response;
      }
      return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) } as Response;
    }) as unknown as HttpFetch;
    const issuer = new RampAgentCardIssuer(config, fetchFn);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' })
    ).rejects.toThrow(/403/);
  });
});

describe('MockCardIssuer', () => {
  it('issues distinct mock cards without any network call', async () => {
    const issuer = new MockCardIssuer();

    const first = await issuer.issueCard({ displayName: 'a', maximumAmountUsd: 1, merchant: 'm' });
    const second = await issuer.issueCard({ displayName: 'b', maximumAmountUsd: 1, merchant: 'm' });

    expect(first.cardId).not.toBe(second.cardId);
    expect(first.state).toBe('ACTIVE');
  });
});
