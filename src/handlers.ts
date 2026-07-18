import type { SpecSpendRuntime } from './runtime.js';

export function getBudgetPolicy(runtime: SpecSpendRuntime, budgetName: string) {
  const budget = runtime.getBudget(budgetName);
  const reportedSpend = runtime.ramp.getReportedSpend(budget.rampBudgetId);
  return {
    rampBudgetId: budget.rampBudgetId,
    monthlyLimit: budget.monthlyLimit,
    reportedSpend,
    availableToAuthorize: runtime.authorizations.getBudgetRemaining(budgetName),
    maxTaskAllowance: budget.maxTaskAllowance,
    allowedModels: budget.allowedModels,
    fallbackModel: budget.fallbackModel,
    onLimit: budget.onLimit,
  };
}

export function authorizeTask(
  runtime: SpecSpendRuntime,
  params: { budget: string; taskId: string; task: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.authorizeTask(params);
}

export function delegateTaskAllowance(
  runtime: SpecSpendRuntime,
  params: { parentCredential: string; agentId: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.delegate(params.parentCredential, params.agentId, params.allowance, params.ttlMs);
}

export function settleTask(runtime: SpecSpendRuntime, authorizationId: string) {
  return runtime.authorizations.settleTask(authorizationId);
}

export function revokeTask(runtime: SpecSpendRuntime, authorizationId: string): void {
  runtime.authorizations.revokeTask(authorizationId);
}
