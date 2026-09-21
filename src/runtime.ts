import { loadConfig, type RampBudgetConfig, type ScripConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { BudgetRouter } from './router.js';
import { AgentTrackRecordStore, MockRampGateway, type RampGateway } from './store.js';

/**
 * The finance boundary the ledger reports to. Only the local JSON-file
 * gateway exists: it records settled receipts and answers "how much has
 * this budget spent this month". A real rail (Natural, a card issuer, a
 * bank) plugs in by implementing RampGateway; see src/rails/ for the one
 * live integration in the repo, which sits at the mission slice's
 * PaymentCapabilityProvider boundary rather than here.
 */
export function createRampGateway(storePath: string): RampGateway {
  return new MockRampGateway(storePath);
}

export class ScripRuntime {
  readonly config: ScripConfig;
  readonly ramp: RampGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(
    configPath: string,
    storePath: string,
    ramp?: RampGateway,
    leaseStorePath?: string,
    trackRecordStorePath?: string
  ) {
    this.config = loadConfig(configPath);
    this.ramp = ramp ?? createRampGateway(storePath);
    const trackRecord = trackRecordStorePath ? new AgentTrackRecordStore(trackRecordStorePath) : undefined;
    this.authorizations = new TaskAuthorizationManager(this.config, this.ramp, leaseStorePath, trackRecord);
  }

  getBudget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown budget "${name}"`);
    return budget;
  }
}
