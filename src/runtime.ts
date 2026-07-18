import { loadConfig, type RampBudgetConfig, type SpecSpendConfig } from './config.js';
import { TaskAuthorizationManager } from './lease.js';
import { BudgetRouter } from './router.js';
import { MockRampGateway, type RampGateway } from './store.js';

export class SpecSpendRuntime {
  readonly config: SpecSpendConfig;
  readonly ramp: RampGateway;
  readonly authorizations: TaskAuthorizationManager;
  readonly router = new BudgetRouter();

  constructor(configPath: string, storePath: string, ramp?: RampGateway) {
    this.config = loadConfig(configPath);
    this.ramp = ramp ?? new MockRampGateway(storePath);
    this.authorizations = new TaskAuthorizationManager(this.config, this.ramp);
  }

  getBudget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }
}
