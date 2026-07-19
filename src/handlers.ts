import type { ScripRuntime } from './runtime.js';

export function getBudgetPolicy(runtime: ScripRuntime, budgetName: string) {
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
  runtime: ScripRuntime,
  params: { budget: string; taskId: string; task: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.authorizeTask(params);
}

export function delegateTaskAllowance(
  runtime: ScripRuntime,
  params: { parentCredential: string; agentId: string; allowance: number; ttlMs?: number }
) {
  return runtime.authorizations.delegate(params.parentCredential, params.agentId, params.allowance, params.ttlMs);
}

export function settleTask(runtime: ScripRuntime, authorizationId: string) {
  return runtime.authorizations.settleTask(authorizationId);
}

export function revokeTask(runtime: ScripRuntime, authorizationId: string): void {
  runtime.authorizations.revokeTask(authorizationId);
}
