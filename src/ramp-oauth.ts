export interface RampOAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope: string;
}

export type HttpFetch = typeof fetch;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/** Client-credentials OAuth against Ramp's token endpoint, confirmed live to use HTTP Basic Auth. */
export class RampOAuthClient {
  private cached: CachedToken | null = null;

  constructor(private config: RampOAuthConfig, private fetchFn: HttpFetch = fetch) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return this.cached.accessToken;
    }

    const basicAuth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const response = await this.fetchFn(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.scope }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Ramp OAuth token request failed with status ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cached = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return this.cached.accessToken;
  }
}
