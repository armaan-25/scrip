import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';
import type { TaskReceipt } from './store.js';

export interface MeterConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  source: string; // platform name sent as `source`, e.g. "scrip"
}

/**
 * Broadcasts settled task usage to Ramp's AI Usage Tracking
 * (POST /developer/v1/ai-usage/unified), confirmed live via Ramp's own
 * assistant as the standard, provider-neutral ingestion path for
 * third-party platforms - see docs/ramp-api-notes.md. Reuses the same
 * OAuth app as RampApiGateway (Option A), scoped to ai_usage:write
 * instead of funds:read.
 */
export class Meter {
  private oauth: RampOAuthClient;

  constructor(private config: MeterConfig, private fetchFn: HttpFetch = fetch) {
    this.oauth = new RampOAuthClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenUrl: `${config.baseUrl}/developer/v1/token`,
        scope: 'ai_usage:write',
      },
      fetchFn
    );
  }

  async reportUsage(receipt: TaskReceipt): Promise<void> {
    const token = await this.oauth.getAccessToken();

    const events = receipt.modelUsage.map((usage) => ({
      event_id: `${receipt.receiptId}:${usage.model}`,
      source: this.config.source,
      occurred_at: receipt.settledAt,
      provider: 'anthropic',
      model: usage.model,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
      pricing_context: {
        service_tier: 'standard',
        fast_mode: false,
        session_created_at: receipt.startedAt,
        long_context: false,
      },
      reported_cost: {
        amount: usage.cost.toString(),
        currency: 'USD',
        provenance: 'scrip-computed',
        estimated: false,
      },
      attribution: {
        session_id: receipt.authorizationId,
        turn_id: receipt.receiptId,
        user_id: receipt.team,
        tags: {
          team: receipt.team,
          rampBudgetId: receipt.rampBudgetId,
          taskId: receipt.taskId,
          costCenter: receipt.costCenter,
          childAgents: String(receipt.childAgents),
        },
      },
    }));

    const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/ai-usage/unified`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schema_version: '1.0', events }),
    });

    if (!response.ok) {
      throw new Error(`Ramp ai-usage/unified broadcast failed with status ${response.status}`);
    }
  }
}
