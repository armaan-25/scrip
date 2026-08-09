import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { MockCardIssuer, RampAgentCardIssuer, RampCliCardIssuer } from '../src/ramp-agent-card.js';
import type { HttpFetch } from '../src/ramp-oauth.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const mockExecFile = vi.mocked(execFile);

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
  it('mints a card from a single synchronous Card Vault response', async () => {
    const fetchFn = fakeFetch([
      tokenResponse,
      { spend_limit_id: 'limit-1', card: { id: 'card-1', pan: '4403900918004242' } },
    ]);
    const issuer = new RampAgentCardIssuer(config, fetchFn);

    const card = await issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' });

    expect(card).toEqual({ cardId: 'card-1', last4: '4242', state: 'ACTIVE' });
    const [url, createInit] = fetchFn.mock.calls[1];
    expect(url).toBe('https://demo-api.ramp.com/developer/v1/cards/vault');
    const requestBody = JSON.parse(String(createInit?.body));
    expect(requestBody.user_id).toBe('user-1');
    expect(requestBody.spending_restrictions).toEqual({ interval: 'TOTAL', limit: { amount: 1250, currency_code: 'USD' } });
  });

  it('throws when the create request itself fails', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('grant_type')) {
        return { ok: true, status: 200, json: async () => tokenResponse } as Response;
      }
      return { ok: false, status: 403, text: async () => '{"error":"forbidden"}' } as Response;
    }) as unknown as HttpFetch;
    const issuer = new RampAgentCardIssuer(config, fetchFn);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' })
    ).rejects.toThrow(/403/);
  });
});

describe('RampCliCardIssuer', () => {
  const cliConfig = { cliBin: 'ramp', env: 'sandbox' as const };

  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('mints a real card by shelling out to `ramp funds creds`', async () => {
    mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
      const callback = callArgs[callArgs.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      const stdout = JSON.stringify({ data: [{ pan: '4111111111111111', cvv: '123' }] });
      callback(null, stdout, '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
    const issuer = new RampCliCardIssuer(cliConfig);

    const card = await issuer.issueCard({
      displayName: 'vendor license',
      maximumAmountUsd: 12.5,
      merchant: 'openai.com',
      fundId: 'fund-1',
    });

    expect(card.last4).toBe('1111');
    expect(card.state).toBe('ACTIVE');
    expect(card.cardId).toMatch(/^[0-9a-f-]{36}$/);

    const [command, args] = mockExecFile.mock.calls[0];
    expect(command).toBe('ramp');
    expect(args).toEqual([
      '-e',
      'sandbox',
      '--agent',
      'funds',
      'creds',
      'fund-1',
      '--amount',
      '12.50',
      '--currency_code',
      'USD',
      '--merchant_country_code',
      'US',
      '--merchant_name',
      'openai.com',
      '--merchant_url',
      'https://openai.com',
      '--rationale',
      'Scrip reservation: vendor license',
    ]);
  });

  it('throws before ever shelling out when no fundId is given', async () => {
    const issuer = new RampCliCardIssuer(cliConfig);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com' })
    ).rejects.toThrow(/requires a fundId/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('surfaces ramp-cli\'s real structured error message on failure', async () => {
    mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
      const callback = callArgs[callArgs.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      const error = new Error('Command failed with exit code 2') as Error & { stdout?: string };
      const stdout = JSON.stringify({ error: { code: 2, message: 'Missing required flags: --merchant_country_code' } });
      error.stdout = stdout;
      callback(error, stdout, '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
    const issuer = new RampCliCardIssuer(cliConfig);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com', fundId: 'fund-1' })
    ).rejects.toThrow(/Missing required flags: --merchant_country_code/);
  });

  it('falls back to the raw error message when stdout is not real JSON', async () => {
    mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
      const callback = callArgs[callArgs.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('ENOENT: ramp binary not found'), '', '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
    const issuer = new RampCliCardIssuer(cliConfig);

    await expect(
      issuer.issueCard({ displayName: 'vendor license', maximumAmountUsd: 12.5, merchant: 'openai.com', fundId: 'fund-1' })
    ).rejects.toThrow(/ENOENT: ramp binary not found/);
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
