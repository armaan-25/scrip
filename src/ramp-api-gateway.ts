import { LocalReceiptStore, type RampGateway, type TaskReceipt } from './store.js';
import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';
import type { Meter } from './meter.js';

export interface RampApiGatewayConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string; // e.g. https://demo-api.ramp.com (sandbox) or https://api.ramp.com (production)
  /** rampBudgetId label (as written to receipts) -> real Ramp Fund UUID. */
  fundIdsByBudget: Record<string, string>;
}

interface RampMinorAmount {
  amount: number;
  currency_code: string;
  minor_unit_conversion_rate: number;
}

interface RampFundResponse {
  id: string;
  balance: { total: RampMinorAmount };
}

/**
 * Reads real Ramp Fund balances via OAuth (confirmed live schema, see
 * docs/ramp-api-notes.md). Writes always go to LocalReceiptStore first,
 * and best-effort broadcast to Ramp's AI Usage Tracking via an optional
 * injected Meter - a failed broadcast never blocks or throws, since the
 * local receipt is already the source of truth by that point.
 *
 * getReportedSpend/reportTaskUsage are both called with the same
 * rampBudgetId label TaskAuthorizationManager already uses everywhere else
 * - this class alone resolves that label to a real Fund ID for reads,
 * since only it knows the identifier space its underlying reads live in.
 */
export class RampApiGateway implements RampGateway {
  private oauth: RampOAuthClient;
  private receipts: LocalReceiptStore;

  constructor(
    private config: RampApiGatewayConfig,
    receiptStorePath: string,
    private fetchFn: HttpFetch = fetch,
    private readonly meter?: Meter
  ) {
    this.oauth = new RampOAuthClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenUrl: `${config.baseUrl}/developer/v1/token`,
        scope: 'funds:read',
      },
      fetchFn
    );
    this.receipts = new LocalReceiptStore(receiptStorePath);
  }

  async getReportedSpend(rampBudgetId: string): Promise<number> {
    const fundId = this.config.fundIdsByBudget[rampBudgetId];
    if (!fundId) {
      throw new Error(`No Ramp Fund ID configured for budget "${rampBudgetId}" (set ramp_fund_id in scrip.yaml)`);
    }

    const token = await this.oauth.getAccessToken();
    const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/funds/${fundId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Ramp Fund balance request for "${fundId}" failed with status ${response.status}`);
    }

    const body = (await response.json()) as RampFundResponse;
    const { amount, minor_unit_conversion_rate } = body.balance.total;
    return amount / minor_unit_conversion_rate;
  }

  async reportTaskUsage(receipt: TaskReceipt): Promise<void> {
    this.receipts.addReceipt(receipt);

    if (this.meter) {
      try {
        await this.meter.reportUsage(receipt);
      } catch (error) {
        // The local write already succeeded and is the source of truth for
        // this process; a failed broadcast to Ramp is a reporting gap, not
        // a control failure - the money's already committed by this point.
        console.warn(
          `[meter] failed to broadcast usage for receipt ${receipt.receiptId}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
