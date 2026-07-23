import type { ActionType, OutcomeEvidence, TaskOutcomeStatus } from './store.js';
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
  outcome?: { status: TaskOutcomeStatus; evidence?: string; evidenceDetail?: OutcomeEvidence[] }
) {
  return runtime.authorizations.settleTask(authorizationId, outcome);
}

export function revokeTask(runtime: ScripRuntime, authorizationId: string): void {
  runtime.authorizations.revokeTask(authorizationId);
}

export function showTask(runtime: ScripRuntime, authorizationId: string) {
  return runtime.authorizations.getAuthorization(authorizationId);
}

export function showTaskTree(runtime: ScripRuntime, authorizationId: string) {
  return runtime.authorizations.getLeaseTree(authorizationId);
}

export async function showReceipt(runtime: ScripRuntime, authorizationId: string) {
  const receipt = await runtime.ramp.getReceipt(authorizationId);
  if (!receipt) throw new Error(`No settled receipt for task authorization "${authorizationId}"`);
  return receipt;
}

export function reserveAction(
  runtime: ScripRuntime,
  params: { credential: string; actionType: ActionType; label: string; maximumCost: number }
) {
  return runtime.authorizations.reserveAction(params.credential, params.actionType, params.label, params.maximumCost);
}

export function commitAction(runtime: ScripRuntime, reservationId: string, actualCost: number): void {
  runtime.authorizations.commitAction(reservationId, actualCost);
}

export function cancelAction(runtime: ScripRuntime, reservationId: string): void {
  runtime.authorizations.cancelAction(reservationId);
}
