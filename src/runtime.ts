import { loadConfig, type FeatureConfig, type ProjectConfig, type SpendConfig } from './config.js';
import { MockRampStore } from './store.js';
import { LeaseManager } from './lease.js';
import { BudgetRouter } from './router.js';

export class SpendSpecRuntime {
  readonly config: SpendConfig;
  readonly store: MockRampStore;
  readonly leaseManager: LeaseManager;
  readonly router: BudgetRouter;

  constructor(configPath: string, storePath: string) {
    this.config = loadConfig(configPath);
    this.store = new MockRampStore(storePath);
    this.leaseManager = new LeaseManager(this.config, this.store);
    this.router = new BudgetRouter();
  }

  getFeatureConfig(project: string, feature: string): { projectConfig: ProjectConfig; featureConfig: FeatureConfig } {
    const projectConfig = this.config.projects[project];
    if (!projectConfig) throw new Error(`Unknown project "${project}"`);
    const featureConfig = projectConfig.features[feature];
    if (!featureConfig) throw new Error(`Unknown feature "${feature}" in project "${project}"`);
    return { projectConfig, featureConfig };
  }
}
