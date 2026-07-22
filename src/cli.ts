import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, revokeTask, settleTask } from './handlers.js';
import type { ScripRuntime } from './runtime.js';
import type { TaskOutcomeStatus } from './store.js';

export class UsageError extends Error {}

const USAGE = 'Usage: scrip <status|authorize|delegate|settle|revoke> ...';

export async function runCli(runtime: ScripRuntime, argv: string[]): Promise<string> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'status':
      return runStatus(runtime, rest);
    case 'authorize':
      return runAuthorize(runtime, rest);
    case 'delegate':
      return runDelegate(runtime, rest);
    case 'settle':
      return runSettle(runtime, rest);
    case 'revoke':
      return runRevoke(runtime, rest);
    default:
      throw new UsageError(USAGE);
  }
}

async function runStatus(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [budget] = args;
  if (!budget) throw new UsageError('Usage: scrip status <budget>');

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

async function runAuthorize(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [budget, taskId, allowanceArg, ...taskWords] = args;
  if (!budget || !taskId || !allowanceArg || taskWords.length === 0) {
    throw new UsageError('Usage: scrip authorize <budget> <taskId> <allowance> <task description...>');
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

function runDelegate(runtime: ScripRuntime, args: string[]): string {
  const [parentCredential, agentId, allowanceArg] = args;
  if (!parentCredential || !agentId || !allowanceArg) {
    throw new UsageError('Usage: scrip delegate <parentCredential> <agentId> <allowance>');
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

function parseFlags(args: string[]): { status?: string; evidence?: string } {
  const flags: { status?: string; evidence?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--status') flags.status = args[i + 1];
    else if (args[i] === '--evidence') flags.evidence = args[i + 1];
  }
  return flags;
}

async function runSettle(runtime: ScripRuntime, args: string[]): Promise<string> {
  const [authorizationId, ...flagArgs] = args;
  if (!authorizationId) {
    throw new UsageError('Usage: scrip settle <authorizationId> [--status success|failure|unknown] [--evidence "text"]');
  }

  const flags = parseFlags(flagArgs);
  const outcome = flags.status ? { status: flags.status as TaskOutcomeStatus, evidence: flags.evidence } : undefined;

  const receipt = await settleTask(runtime, authorizationId, outcome);
  const modelLines = receipt.modelUsage.map(
    (m) => `  ${m.model}: ${m.requests} requests, ${m.inputTokens} in / ${m.outputTokens} out, $${m.cost.toFixed(6)}`
  );
  return [
    `authorized: $${receipt.authorized.toFixed(4)}`,
    `actual: $${receipt.actual.toFixed(4)}`,
    `returned: $${receipt.returned.toFixed(4)}`,
    `requestCount: ${receipt.requestCount}`,
    `childAgents: ${receipt.childAgents}`,
    'modelUsage:',
    ...modelLines,
    `outcome: ${receipt.outcome}`,
    ...(receipt.outcomeEvidence ? [`outcomeEvidence: ${receipt.outcomeEvidence}`] : []),
  ].join('\n');
}

function runRevoke(runtime: ScripRuntime, args: string[]): string {
  const [authorizationId] = args;
  if (!authorizationId) throw new UsageError('Usage: scrip revoke <authorizationId>');

  revokeTask(runtime, authorizationId);
  return `Revoked authorization ${authorizationId}`;
}
