import { LocalReceiptStore, type RampGateway, type TaskReceipt } from './store.js';
import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';

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
 * docs/ramp-api-notes.md). Writes stay local (LocalReceiptStore) - a real
 * Ramp financial write for arbitrary usage events isn't possible without
 * Vault card issuance, which this project doesn't have. See Meter (design
 * only, not yet built) for the ai-usage/unified broadcast write path.
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
    private fetchFn: HttpFetch = fetch
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
  }
}
