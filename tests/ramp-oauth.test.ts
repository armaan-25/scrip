import { describe, expect, it, vi } from 'vitest';
import { RampOAuthClient, type HttpFetch } from '../src/ramp-oauth.js';

function fakeFetch(responses: Array<{ access_token: string; expires_in: number }>) {
  let call = 0;
  return vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as HttpFetch & ReturnType<typeof vi.fn>;
}

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  tokenUrl: 'https://demo-api.ramp.com/developer/v1/token',
  scope: 'funds:read',
};

describe('RampOAuthClient', () => {
  it('fetches an access token using HTTP Basic Auth', async () => {
    const fetchFn = fakeFetch([{ access_token: 'token-abc', expires_in: 3600 }]);
    const client = new RampOAuthClient(config, fetchFn);

    const token = await client.getAccessToken();

    expect(token).toBe('token-abc');
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(config.tokenUrl);
    expect(init?.method).toBe('POST');
    const expectedAuth = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    expect((init?.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    expect(String(init?.body)).toContain('grant_type=client_credentials');
    expect(String(init?.body)).toContain('scope=funds%3Aread');
  });

  it('reuses a cached token until it is near expiry', async () => {
    const fetchFn = fakeFetch([{ access_token: 'token-abc', expires_in: 3600 }]);
    const client = new RampOAuthClient(config, fetchFn);

    await client.getAccessToken();
    await client.getAccessToken();

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('re-fetches once the cached token is within 60 seconds of expiry', async () => {
    const fetchFn = fakeFetch([
      { access_token: 'token-abc', expires_in: 30 },
      { access_token: 'token-def', expires_in: 3600 },
    ]);
    const client = new RampOAuthClient(config, fetchFn);

    const first = await client.getAccessToken();
    const second = await client.getAccessToken();

    expect(first).toBe('token-abc');
    expect(second).toBe('token-def');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws when the token endpoint responds with an error', async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ error: 'invalid_client' }),
        }) as Response
    );
    const client = new RampOAuthClient(config, fetchFn);

    await expect(client.getAccessToken()).rejects.toThrow(/401/);
  });
});
