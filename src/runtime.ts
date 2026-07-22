import { loadConfig, type RampBudgetConfig, type ScripConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { Meter } from './meter.js';
import { RampApiGateway } from './ramp-api-gateway.js';
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

export class ScripRuntime {
  readonly config: ScripConfig;
  readonly ramp: RampGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(configPath: string, storePath: string, ramp?: RampGateway, leaseStorePath?: string) {
    this.config = loadConfig(configPath);
    this.ramp = ramp ?? createRampGateway(storePath, this.config);
    this.authorizations = new TaskAuthorizationManager(this.config, this.ramp, leaseStorePath);
  }

  getBudget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }
}
