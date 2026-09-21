import { loadConfig, type BudgetConfig, type ScripConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { BudgetRouter } from './router.js';
import { AgentTrackRecordStore, LocalFinanceGateway, type FinanceGateway } from './store.js';

/**
 * The finance boundary the ledger reports to. Only the local JSON-file
 * gateway exists: it records settled receipts and answers "how much has
 * this budget spent this month". A real rail (Natural, a card issuer, a
 * bank) plugs in by implementing FinanceGateway; see src/rails/ for the one
 * live integration in the repo, which sits at the mission slice's
 * PaymentCapabilityProvider boundary rather than here.
 */
export function createFinanceGateway(storePath: string): FinanceGateway {
  return new LocalFinanceGateway(storePath);
}

export class ScripRuntime {
  readonly config: ScripConfig;
  readonly finance: FinanceGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(
    configPath: string,
    storePath: string,
    finance?: FinanceGateway,
    leaseStorePath?: string,
    trackRecordStorePath?: string
  ) {
    this.config = loadConfig(configPath);
    this.finance = finance ?? createFinanceGateway(storePath);
    const trackRecord = trackRecordStorePath ? new AgentTrackRecordStore(trackRecordStorePath) : undefined;
    this.authorizations = new TaskAuthorizationManager(this.config, this.finance, leaseStorePath, trackRecord);
  }

  getBudget(name: string): BudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown budget "${name}"`);
    return budget;
  }
}
