import { loadConfig, type RampBudgetConfig, type ScripConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { Meter } from './meter.js';
import { RampApiGateway } from './ramp-api-gateway.js';
import { MockCardIssuer, RampAgentCardIssuer, type CardIssuer } from './ramp-agent-card.js';
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
 * cards:write is a separate scope from funds:read/ai_usage:write (see
 * docs/ramp-api-notes.md), and card issuance additionally needs a real
 * cardholder Ramp user - so this only wires in the real issuer when
 * RAMP_CARDHOLDER_USER_ID is set, even if RAMP_CLIENT_ID/SECRET already are.
 */
export function createCardIssuer(): CardIssuer {
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  const cardholderUserId = process.env.RAMP_CARDHOLDER_USER_ID;

  if (clientId && clientSecret && cardholderUserId) {
    const baseUrl = process.env.RAMP_API_BASE_URL ?? 'https://demo-api.ramp.com';
    console.log(`[ramp] using RampAgentCardIssuer (${baseUrl})`);
    return new RampAgentCardIssuer({ clientId, clientSecret, baseUrl, cardholderUserId });
  }

  console.log('[ramp] RAMP_CARDHOLDER_USER_ID not set, using MockCardIssuer');
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
