import fs from 'node:fs';
import {
  authorizeTask,
  cancelAction,
  commitAction,
  delegateTaskAllowance,
  getBudgetPolicy,
  reserveAction,
  revokeTask,
  settleTask,
  showReceipt,
  showTask,
  showTaskTree,
} from './handlers.js';
import type { ScripRuntime } from './runtime.js';
import type { ActionType, TaskOutcomeStatus } from './store.js';

export class UsageError extends Error {}

const USAGE = 'Usage: scrip <budget|task|action|receipt> <verb> ...';

export async function runCli(runtime: ScripRuntime, argv: string[]): Promise<string> {
  const [noun, verb, ...rest] = argv;

  switch (noun) {
    case 'budget':
      return runBudget(runtime, verb, rest);
    case 'task':
      return runTask(runtime, verb, rest);
    case 'action':
      return runAction(runtime, verb, rest);
    case 'receipt':
      return runReceipt(runtime, verb, rest);
    default:
      throw new UsageError(USAGE);
  }
}

// ---- budget ----------------------------------------------------------

async function runBudget(runtime: ScripRuntime, verb: string | undefined, args: string[]): Promise<string> {
  if (verb !== 'status') throw new UsageError('Usage: scrip budget status <budget>');

  const [budget] = args;
  if (!budget) throw new UsageError('Usage: scrip budget status <budget>');

  const policy = await getBudgetPolicy(runtime, budget);
  return [
    `rampBudgetId: ${policy.rampBudgetId}`,
    `monthlyLimit: $${policy.monthlyLimit.toFixed(4)}`,
    `reportedSpend: $${policy.reportedSpend.toFixed(4)}`,
    `availableToAuthorize: $${policy.availableToAuthorize.toFixed(4)}`,
    `maxTaskAllowance: $${policy.maxTaskAllowance.toFixed(4)}`,
    `allowedModels: ${policy.allowedModels.join(', ')}`,
    `fallbackModel: ${policy.fallbackModel}`,
    `onLimit: ${policy.onLimit}`,
  ].join('\n');
}

// ---- task --------------------------------------------------------------

const TASK_USAGE =
  'Usage: scrip task <authorize|delegate|show|tree|settle|revoke> ...';

async function runTask(runtime: ScripRuntime, verb: string | undefined, args: string[]): Promise<string> {
  switch (verb) {
    case 'authorize':
      return runTaskAuthorize(runtime, args);
    case 'delegate':
      return runTaskDelegate(runtime, args);
    case 'show':
      return runTaskShow(runtime, args);
    case 'tree':
      return runTaskTree(runtime, args);
    case 'settle':
      return runTaskSettle(runtime, args);
    case 'revoke':
      return runTaskRevoke(runtime, args);
    default:
      throw new UsageError(TASK_USAGE);
  }
}

async function runTaskAuthorize(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [budget, taskId, allowanceArg, ...taskWords] = args;
  if (!budget || !taskId || !allowanceArg || taskWords.length === 0) {
    throw new UsageError('Usage: scrip task authorize <budget> <taskId> <allowance> <task description...>');
  }
  const allowance = Number(allowanceArg);
  if (Number.isNaN(allowance)) {
    throw new UsageError(`Allowance must be a number, got "${allowanceArg}"`);
  }
  const task = taskWords.join(' ');

  const issued = await authorizeTask(runtime, { budget, taskId, task, allowance });
  return [
    `credential: ${issued.credential}`,
    `authorizationId: ${issued.authorization.authorizationId}`,
    `allowance: $${issued.authorization.allowance.toFixed(4)}`,
    `task: ${issued.authorization.task}`,
    `expiresAt: ${issued.authorization.expiresAt}`,
  ].join('\n');
}

function runTaskDelegate(runtime: ScripRuntime, args: string[]): string {
  const [parentCredential, agentId, allowanceArg] = args;
  if (!parentCredential || !agentId || !allowanceArg) {
    throw new UsageError('Usage: scrip task delegate <parentCredential> <agentId> <allowance>');
  }
  const allowance = Number(allowanceArg);
  if (Number.isNaN(allowance)) {
    throw new UsageError(`Allowance must be a number, got "${allowanceArg}"`);
  }

  const issued = delegateTaskAllowance(runtime, { parentCredential, agentId, allowance });
  return [
    `credential: ${issued.credential}`,
    `leaseId: ${issued.lease.leaseId}`,
    `allowance: $${issued.lease.allowance.toFixed(4)}`,
    `depth: ${issued.lease.depth}`,
    `expiresAt: ${issued.lease.expiresAt}`,
  ].join('\n');
}

function runTaskShow(runtime: ScripRuntime, args: string[]): string {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip task show <authorizationId>');

  const task = showTask(runtime, authorizationId);
  return [
    `authorizationId: ${task.authorizationId}`,
    `taskId: ${task.taskId}`,
    `task: ${task.task}`,
    `budgetName: ${task.budgetName}`,
    `status: ${task.status}`,
    `allowance: $${task.allowance.toFixed(4)}`,
    `spent: $${task.spent.toFixed(4)}`,
    `pending: $${task.pending.toFixed(4)}`,
    `createdAt: ${task.createdAt}`,
    `expiresAt: ${task.expiresAt}`,
  ].join('\n');
}

function runTaskTree(runtime: ScripRuntime, args: string[]): string {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip task tree <authorizationId>');

  const leases = showTaskTree(runtime, authorizationId);
  if (leases.length === 0) return `No leases found for task ${authorizationId}`;

  return leases
    .map((lease) => {
      const indent = '  '.repeat(lease.depth);
      return (
        `${indent}[depth ${lease.depth}] ${lease.agentId} (${lease.leaseId}) ` +
        `status=${lease.status} allowance=$${lease.allowance.toFixed(4)} spent=$${lease.spent.toFixed(4)} pending=$${lease.pending.toFixed(4)}`
      );
    })
    .join('\n');
}

function parseFlags(args: string[]): { status?: string; evidence?: string } {
  const flags: { status?: string; evidence?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--status') flags.status = args[i + 1];
    else if (args[i] === '--evidence') flags.evidence = args[i + 1];
  }
  return flags;
}

async function runTaskSettle(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [authorizationId, ...flagArgs] = args;
  if (!authorizationId) {
    throw new UsageError('Usage: scrip task settle <authorizationId> [--status success|failure|unknown] [--evidence "text"]');
  }

  const flags = parseFlags(flagArgs);
  const outcome = flags.status ? { status: flags.status as TaskOutcomeStatus, evidence: flags.evidence } : undefined;

  const receipt = await settleTask(runtime, authorizationId, outcome);
  return formatReceipt(receipt);
}

function runTaskRevoke(runtime: ScripRuntime, args: string[]): string {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip task revoke <authorizationId>');

  revokeTask(runtime, authorizationId);
  return `Revoked authorization ${authorizationId}`;
}

// ---- action --------------------------------------------------------------

const ACTION_TYPES: ActionType[] = ['inference', 'paid_api', 'purchase', 'cloud_compute', 'human_approval', 'other'];

async function runAction(runtime: ScripRuntime, verb: string | undefined, args: string[]): Promise<string> {
  switch (verb) {
    case 'reserve':
      return runActionReserve(runtime, args);
    case 'commit':
      return runActionCommit(runtime, args);
    case 'cancel':
      return runActionCancel(runtime, args);
    default:
      throw new UsageError('Usage: scrip action <reserve|commit|cancel> ...');
  }
}

function runActionReserve(runtime: ScripRuntime, args: string[]): string {
  const [credential, actionType, label, maximumCostArg] = args;
  if (!credential || !actionType || !label || !maximumCostArg) {
    throw new UsageError('Usage: scrip action reserve <credential> <actionType> <label> <maximumCost>');
  }
  if (!ACTION_TYPES.includes(actionType as ActionType)) {
    throw new UsageError(`actionType must be one of ${ACTION_TYPES.join(', ')}, got "${actionType}"`);
  }
  const maximumCost = Number(maximumCostArg);
  if (Number.isNaN(maximumCost)) {
    throw new UsageError(`maximumCost must be a number, got "${maximumCostArg}"`);
  }

  const reservation = reserveAction(runtime, { credential, actionType: actionType as ActionType, label, maximumCost });
  return [
    `reservationId: ${reservation.reservationId}`,
    `actionType: ${reservation.actionType}`,
    `label: ${reservation.label}`,
    `maximumCost: $${reservation.maximumCost.toFixed(4)}`,
    `status: ${reservation.status}`,
  ].join('\n');
}

function runActionCommit(runtime: ScripRuntime, args: string[]): string {
  const [reservationId, actualCostArg] = args;
  if (!reservationId || !actualCostArg) {
    throw new UsageError('Usage: scrip action commit <reservationId> <actualCost>');
  }
  const actualCost = Number(actualCostArg);
  if (Number.isNaN(actualCost)) {
    throw new UsageError(`actualCost must be a number, got "${actualCostArg}"`);
  }

  commitAction(runtime, reservationId, actualCost);
  return `Committed ${reservationId}: $${actualCost.toFixed(4)}`;
}

function runActionCancel(runtime: ScripRuntime, args: string[]): string {
  const [reservationId] = args;
  if (!reservationId) throw new UsageError('Usage: scrip action cancel <reservationId>');

  cancelAction(runtime, reservationId);
  return `Cancelled ${reservationId}`;
}

// ---- receipt --------------------------------------------------------------

async function runReceipt(runtime: ScripRuntime, verb: string | undefined, args: string[]): Promise<string> {
  switch (verb) {
    case 'show':
      return runReceiptShow(runtime, args);
    case 'export':
      return runReceiptExport(runtime, args);
    default:
      throw new UsageError('Usage: scrip receipt <show|export> ...');
  }
}

async function runReceiptShow(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip receipt show <authorizationId>');

  const receipt = await showReceipt(runtime, authorizationId);
  return formatReceipt(receipt);
}

async function runReceiptExport(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [authorizationId, outPathArg] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip receipt export <authorizationId> [outputPath]');

  const receipt = await showReceipt(runtime, authorizationId);
  const outPath = outPathArg ?? `${authorizationId}-receipt.json`;
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  return `Exported receipt for ${authorizationId} to ${outPath}`;
}

function formatReceipt(receipt: Awaited<ReturnType<typeof showReceipt>>): string {
  const modelLines = receipt.modelUsage.map(
    (m) => `  ${m.model}: ${m.requests} requests, ${m.inputTokens} in / ${m.outputTokens} out, $${m.cost.toFixed(6)}`
  );
  return [
    `authorized: $${receipt.authorized.toFixed(4)}`,
    `actual: $${receipt.actual.toFixed(4)}`,
    `returned: $${receipt.returned.toFixed(4)}`,
    `workerCount: ${receipt.workerCount}`,
    `actionCount: ${receipt.actionCount}`,
    'modelUsage:',
    ...modelLines,
    'costs:',
    `  inference: $${receipt.costs.inferenceUsd.toFixed(6)}`,
    `  paidApi: $${receipt.costs.paidApiUsd.toFixed(6)}`,
    `  cloudCompute: $${receipt.costs.cloudComputeUsd.toFixed(6)}`,
    `  purchases: $${receipt.costs.purchasesUsd.toFixed(6)}`,
    `  approvalOverhead: $${receipt.costs.approvalOverheadUsd.toFixed(6)}`,
    `  other: $${receipt.costs.otherUsd.toFixed(6)}`,
    `outcome: ${receipt.outcome}`,
    ...(receipt.outcomeEvidence ? [`outcomeEvidence: ${receipt.outcomeEvidence}`] : []),
  ].join('\n');
}
