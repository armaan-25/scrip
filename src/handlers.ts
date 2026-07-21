import type { TaskOutcomeStatus } from './store.js';
import type { ScripRuntime } from './runtime.js';

export async function getBudgetPolicy(runtime: ScripRuntime, budgetName: string) {
  const budget = runtime.getBudget(budgetName);
  // Always the label - RampApiGateway resolves it to a real Fund ID itself
  // (see the same fix and its rationale in TaskAuthorizationManager.getBudgetRemaining()).
  const reportedSpend = await runtime.ramp.getReportedSpend(budget.rampBudgetId);
  return {
    rampBudgetId: budget.rampBudgetId,
    monthlyLimit: budget.monthlyLimit,
    reportedSpend,
    availableToAuthorize: await runtime.authorizations.getBudgetRemaining(budgetName),
    maxTaskAllowance: budget.maxTaskAllowance,
    allowedModels: budget.allowedModels,
    fallbackModel: budget.fallbackModel,
    onLimit: budget.onLimit,
  };
}

export async function authorizeTask(
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

export async function settleTask(
  runtime: ScripRuntime,
  authorizationId: string,
  outcome?: { status: TaskOutcomeStatus; evidence?: string }
) {
  return runtime.authorizations.settleTask(authorizationId, outcome);
}

export function revokeTask(runtime: ScripRuntime, authorizationId: string): void {
  runtime.authorizations.revokeTask(authorizationId);
}
