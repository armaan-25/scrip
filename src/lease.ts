import { randomUUID } from 'node:crypto';
import type { SpendConfig } from './config.js';
import type { MockRampStore } from './store.js';

export interface Lease {
  leaseId: string;
  project: string;
  feature: string;
  reservedAmount: number;
  spent: number;
  released: boolean;
  expiresAt: string;
}

export class SpendLimitExceededError extends Error {}

export class LeaseManager {
  private leases = new Map<string, Lease>();
  private grants = new Map<string, number>();

  constructor(private config: SpendConfig, private store: MockRampStore) {}

  private key(project: string, feature: string): string {
    return `${project}:${feature}`;
  }

  private featureBudget(project: string, feature: string): number {
    const projectConfig = this.config.projects[project];
    if (!projectConfig) throw new Error(`Unknown project "${project}"`);
    const featureConfig = projectConfig.features[feature];
    if (!featureConfig) throw new Error(`Unknown feature "${feature}" in project "${project}"`);
    return featureConfig.monthlyBudget;
  }

  grantAdditionalBudget(project: string, feature: string, amount: number): void {
    const key = this.key(project, feature);
    this.grants.set(key, (this.grants.get(key) ?? 0) + amount);
  }

  getRemainingBudget(project: string, feature: string): number {
    const budget = this.featureBudget(project, feature) + (this.grants.get(this.key(project, feature)) ?? 0);
    const spent = this.store.getSpend(project, feature);
    const reserved = [...this.leases.values()]
      .filter((l) => l.project === project && l.feature === feature && !l.released)
      .reduce((sum, l) => sum + l.reservedAmount, 0);
    return budget - spent - reserved;
  }

  reserve(project: string, feature: string, amount: number, ttlMs = 5 * 60 * 1000): Lease {
    const remaining = this.getRemainingBudget(project, feature);
    if (amount > remaining) {
      throw new SpendLimitExceededError(
        `Cannot reserve $${amount.toFixed(4)} for ${project}/${feature}: only $${remaining.toFixed(4)} remaining`
      );
    }
    const lease: Lease = {
      leaseId: randomUUID(),
      project,
      feature,
      reservedAmount: amount,
      spent: 0,
      released: false,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  getLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`Unknown lease "${leaseId}"`);
    return lease;
  }

  recordSpend(leaseId: string, actualCost: number): void {
    const lease = this.getLease(leaseId);
    lease.spent = actualCost;
  }

  release(leaseId: string): number {
    const lease = this.getLease(leaseId);
    lease.released = true;
    return lease.reservedAmount - lease.spent;
  }
}
