import type { SpendSpecRuntime } from './runtime.js';
import { computeCost } from './pricing.js';

export interface SpendPolicyResult {
  projectBudget: { limit: number; spent: number; remaining: number };
  taskPolicy: {
    maxPerRequest: number;
    allowedModels: string[];
    fallbackModel: string;
    onLimit: string;
  };
}

export function getSpendPolicy(runtime: SpendSpecRuntime, project: string, feature: string): SpendPolicyResult {
  const { featureConfig } = runtime.getFeatureConfig(project, feature);
  const spent = runtime.store.getSpend(project, feature);
  const remaining = runtime.leaseManager.getRemainingBudget(project, feature);
  return {
    projectBudget: { limit: featureConfig.monthlyBudget, spent, remaining },
    taskPolicy: {
      maxPerRequest: featureConfig.maxPerRequest,
      allowedModels: featureConfig.allowedModels,
      fallbackModel: featureConfig.fallbackModel,
      onLimit: featureConfig.onLimit,
    },
  };
}

export interface EstimateSpendParams {
  project: string;
  feature: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  numCalls: number;
}

export function estimateSpend(runtime: SpendSpecRuntime, params: EstimateSpendParams): number {
  runtime.getFeatureConfig(params.project, params.feature);
  const perCall = computeCost(params.model, params.estimatedInputTokens, params.estimatedOutputTokens);
  return perCall * params.numCalls;
}

export interface RequestMoreBudgetResult {
  approved: boolean;
  status: 'approved' | 'pending_approval';
}

const AUTO_APPROVE_CEILING = 1.0;

export function requestMoreBudget(
  runtime: SpendSpecRuntime,
  project: string,
  feature: string,
  amount: number,
  reason: string
): RequestMoreBudgetResult {
  if (amount <= AUTO_APPROVE_CEILING) {
    runtime.leaseManager.grantAdditionalBudget(project, feature, amount);
    console.log(`[approval] auto-approved $${amount.toFixed(2)} for ${project}/${feature}: ${reason}`);
    return { approved: true, status: 'approved' };
  }
  console.log(`[approval] PENDING $${amount.toFixed(2)} for ${project}/${feature}: ${reason}`);
  return { approved: false, status: 'pending_approval' };
}

export interface RecordUsageParams {
  leaseId: string;
  team: string;
  task: string;
  actualCost: number;
  model: string;
  costCenter: string;
}

export function recordUsage(runtime: SpendSpecRuntime, params: RecordUsageParams): void {
  const lease = runtime.leaseManager.getLease(params.leaseId);
  runtime.leaseManager.recordSpend(params.leaseId, params.actualCost);
  runtime.store.addReceipt({
    team: params.team,
    project: lease.project,
    feature: lease.feature,
    task: params.task,
    authorized: lease.reservedAmount,
    actual: params.actualCost,
    model: params.model,
    costCenter: params.costCenter,
    timestamp: new Date().toISOString(),
  });
  runtime.leaseManager.release(params.leaseId);
}
