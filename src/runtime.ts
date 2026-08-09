import { loadConfig, type RampBudgetConfig, type ScripConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { Meter } from './meter.js';
import { RampApiGateway } from './ramp-api-gateway.js';
import { MockCardIssuer, RampAgentCardIssuer, RampCliCardIssuer, type CardIssuer } from './ramp-agent-card.js';
import { BudgetRouter } from './router.js';
import { MockRampGateway, type RampGateway } from './store.js';

export function createRampGateway(storePath: string, config: ScripConfig): RampGateway {
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;

  if (clientId && clientSecret) {
    const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';
    const fundIdsByBudget: Record<string, string> = {};
    for (const budget of Object.values(config.budgets)) {
      if (budget.rampFundId) fundIdsByBudget[budget.rampBudgetId] = budget.rampFundId;
    }
    // Same OAuth app as the read side, scoped to ai_usage:write instead of
    // funds:read (Option A: one app, two scopes - see docs/ramp-api-notes.md).
    // Broadcast failures (e.g. the scope not added yet) are logged and
    // swallowed by RampApiGateway, never thrown, so it's safe to always wire in.
    const meter = new Meter({ clientId, clientSecret, baseUrl, source: 'scrip' });
    console.log(`[ramp] using RampApiGateway (${baseUrl})`);
    return new RampApiGateway({ clientId, clientSecret, baseUrl, fundIdsByBudget }, storePath, fetch, meter);
  }

  console.log('[ramp] RAMP_CLIENT_ID/RAMP_CLIENT_SECRET not set, using MockRampGateway');
  return new MockRampGateway(storePath);
}

/**
 * Three possible card issuers, in preference order:
 *
 * 1. RampCliCardIssuer - mints a REAL Ramp Agent Card by shelling out to
 *    the real `ramp-cli` binary, live-verified working. Opt in with
 *    RAMP_CLI_BIN (e.g. "ramp", or an absolute path) - requires `ramp auth
 *    login` already done interactively; this process never does that
 *    itself. Preferred whenever set, since it's the only issuer here that
 *    mints Ramp's actual Agent Cards product rather than an adjacent one.
 * 2. RampAgentCardIssuer - mints a real Ramp *Vault API* card (a different,
 *    non-agent Ramp product - see docs/ramp-api-notes.md) via direct REST
 *    with client-credentials OAuth. Opt in with RAMP_CARDHOLDER_USER_ID.
 * 3. MockCardIssuer - zero-network fallback, used when neither is set.
 */
export function createCardIssuer(): CardIssuer {
  const cliBin = process.env.RAMP_CLI_BIN;
  if (cliBin) {
    const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';
    const env = baseUrl.includes('demo-api') ? 'sandbox' : 'production';
    console.log(`[ramp] using RampCliCardIssuer (${cliBin}, -e ${env})`);
    return new RampCliCardIssuer({ cliBin, env });
  }

  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  const cardholderUserId = process.env.RAMP_CARDHOLDER_USER_ID;

  if (clientId && clientSecret && cardholderUserId) {
    const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';
    console.log(`[ramp] using RampAgentCardIssuer (${baseUrl})`);
    return new RampAgentCardIssuer({ clientId, clientSecret, baseUrl, cardholderUserId });
  }

  console.log('[ramp] no RAMP_CLI_BIN or RAMP_CARDHOLDER_USER_ID set, using MockCardIssuer');
  return new MockCardIssuer();
}

export class ScripRuntime {
  readonly config: ScripConfig;
  readonly ramp: RampGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(configPath: string, storePath: string, ramp?: RampGateway, leaseStorePath?: string) {
    this.config = loadConfig(configPath);
    this.ramp = ramp ?? createRampGateway(storePath, this.config);
    this.authorizations = new TaskAuthorizationManager(this.config, this.ramp, leaseStorePath, createCardIssuer());
  }

  getBudget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }
}
