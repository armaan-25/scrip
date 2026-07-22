import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RampBudgetConfig, ScripConfig } from './config.js';
import { computeCost, getModelPrice } from './pricing.js';
import {
  computeCostBreakdown,
  type ActionType,
  type ActionUsage,
  type ModelUsage,
  type OutcomeEvidence,
  type RampGateway,
  type TaskOutcomeStatus,
  type TaskReceipt,
} from './store.js';

export type AuthorizationStatus = 'active' | 'settled' | 'revoked';
export type LeaseStatus = 'active' | 'settled' | 'revoked';

export interface TaskAuthorization {
  authorizationId: string;
  budgetName: string;
  rampBudgetId: string;
  taskId: string;
  task: string;
  allowance: number;
  spent: number;
  pending: number;
  status: AuthorizationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface InferenceLease {
  leaseId: string;
  authorizationId: string;
  parentLeaseId?: string;
  agentId: string;
  allowance: number;
  spent: number;
  pending: number;
  status: LeaseStatus;
  expiresAt: string;
  depth: number;
}

export interface IssuedTaskAuthorization {
  authorization: TaskAuthorization;
  lease: InferenceLease;
  credential: string;
}

/**
 * Aliases toward the pivot's domain vocabulary (TaskExecution/ExecutionLease
 * replacing TaskAuthorization/InferenceLease as the product's primary
 * nouns). Field names (allowance/spent/pending) are unchanged for now - see
 * docs/PIVOT_AUDIT.md §8.4 on why a full field-level rename is staged
 * separately from the type-name rename, rather than done in the same pass.
 */
export type TaskExecution = TaskAuthorization;
export type IssuedTaskExecution = IssuedTaskAuthorization;
export type ExecutionLease = InferenceLease;

export interface IssuedChildLease {
  lease: InferenceLease;
  credential: string;
}

export interface TaskEvidenceSnapshot {
  task: string;
  allowance: number;
  spent: number;
  pending: number;
  requestCount: number;
  childAgents: number;
  elapsedSeconds: number;
  modelUsage: ModelUsage[];
  requestedShortfall: number;
}

export type EconomicActionStatus = 'reserved' | 'committed' | 'cancelled';

export interface ActionReservation {
  reservationId: string;
  /** = reservationId. The pivot's canonical field name; both resolve the same reservation. */
  actionId: string;
  authorizationId: string;
  leaseId: string;
  actionType: ActionType;
  label: string;
  maximumCost: number;
  /** = maximumCost. The pivot's canonical field name for the same value. */
  estimatedCostUsd: number;
  status: EconomicActionStatus;
  /**
   * Free-form per-action detail (e.g. a purchase's vendor, a compute job's
   * region). Always an object, never undefined, so callers never need an
   * existence check before reading a key off it.
   */
  metadata: Record<string, unknown>;
}

/** Alias toward the pivot's domain vocabulary - EconomicAction is exactly this shape already. */
export type EconomicAction = ActionReservation;

/** Preserved name for callers already importing RequestReservation (e.g. src/proxy.ts). */
export type RequestReservation = ActionReservation;

interface ActionEvent {
  actionType: ActionType;
  label: string;
  cost: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface InternalLease extends InferenceLease {
  credentialHash: Buffer;
}

/** On-disk shape for optional cross-process persistence - see storePath on TaskAuthorizationManager. */
interface PersistedLeaseState {
  authorizations: TaskAuthorization[];
  leases: (Omit<InternalLease, 'credentialHash'> & { credentialHash: string })[];
  reservations: ActionReservation[];
  usage: Record<string, ActionEvent[]>;
}

export class SpendLimitExceededError extends Error {}
export class InvalidCredentialError extends Error {}
export class ApprovalRequiredError extends Error {}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential).digest();
}

function issueCredential(): string {
  return `scrip_${randomBytes(24).toString('base64url')}`;
}

/** The lowest-outputPrice model in a budget's allowed list — the mirror image of BudgetRouter's priciest-first pick. */
function cheapestModel(allowedModels: string[]): string {
  return [...allowedModels].sort((a, b) => getModelPrice(a).outputPrice - getModelPrice(b).outputPrice)[0];
}

export class TaskAuthorizationManager {
  private authorizations = new Map<string, TaskAuthorization>();
  private leases = new Map<string, InternalLease>();
  private reservations = new Map<string, ActionReservation>();
  private usage = new Map<string, ActionEvent[]>();

  // Optional: authorizations/leases/reservations/usage are in-memory only by
  // default (matches every caller before this was added - the MCP server and
  // demo scripts are each one long-running process end to end, so they never
  // needed this). A CLI is a fresh process per invocation, so it opts in by
  // passing a storePath, the same JSON-file pattern LocalReceiptStore
  // already uses for settled receipts.
  constructor(private config: ScripConfig, private ramp: RampGateway, private storePath?: string) {
    if (this.storePath && fs.existsSync(this.storePath)) {
      this.load();
    }
  }

  private load(): void {
    const data: PersistedLeaseState = JSON.parse(fs.readFileSync(this.storePath!, 'utf-8'));
    this.authorizations = new Map(data.authorizations.map((a) => [a.authorizationId, a]));
    this.leases = new Map(
      data.leases.map((l) => [l.leaseId, { ...l, credentialHash: Buffer.from(l.credentialHash, 'base64') }])
    );
    this.reservations = new Map(data.reservations.map((r) => [r.reservationId, r]));
    this.usage = new Map(Object.entries(data.usage));
  }

  private persist(): void {
    if (!this.storePath) return;
    const data: PersistedLeaseState = {
      authorizations: [...this.authorizations.values()],
      leases: [...this.leases.values()].map((l) => ({ ...l, credentialHash: l.credentialHash.toString('base64') })),
      reservations: [...this.reservations.values()],
      usage: Object.fromEntries(this.usage),
    };
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2) + '\n');
  }

  private budget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }

  async getBudgetRemaining(name: string): Promise<number> {
    const budget = this.budget(name);
    // Always the same label used to write receipts in settleTask() - a
    // gateway that needs a different identifier (a real Fund ID) resolves
    // that translation itself, since only it knows which identifier space
    // its reads and writes actually live in.
    const reported = await this.ramp.getReportedSpend(budget.rampBudgetId);
    const activeAllowances = [...this.authorizations.values()]
      .filter((authorization) => authorization.budgetName === name && authorization.status === 'active')
      .reduce((sum, authorization) => sum + authorization.allowance, 0);
    return budget.monthlyLimit - reported - activeAllowances;
  }

  async authorizeTask(params: {
    budget: string;
    taskId: string;
    task: string;
    allowance: number;
    ttlMs?: number;
  }): Promise<IssuedTaskAuthorization> {
    const budget = this.budget(params.budget);
    if (params.allowance <= 0 || params.allowance > budget.maxTaskAllowance) {
      throw new SpendLimitExceededError(
        `Task allowance must be between $0 and $${budget.maxTaskAllowance.toFixed(4)}`
      );
    }
    const remaining = await this.getBudgetRemaining(params.budget);
    if (params.allowance > remaining) {
      throw new SpendLimitExceededError(
        `Cannot authorize $${params.allowance.toFixed(4)} from Ramp budget ${budget.rampBudgetId}: ` +
          `$${remaining.toFixed(4)} remains`
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? budget.taskTtlSeconds * 1000)).toISOString();
    const authorization: TaskAuthorization = {
      authorizationId: randomUUID(),
      budgetName: params.budget,
      rampBudgetId: budget.rampBudgetId,
      taskId: params.taskId,
      task: params.task,
      allowance: params.allowance,
      spent: 0,
      pending: 0,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt,
    };
    const credential = issueCredential();
    const lease: InternalLease = {
      leaseId: randomUUID(),
      authorizationId: authorization.authorizationId,
      agentId: 'root',
      allowance: params.allowance,
      spent: 0,
      pending: 0,
      status: 'active',
      expiresAt,
      depth: 0,
      credentialHash: hashCredential(credential),
    };
    this.authorizations.set(authorization.authorizationId, authorization);
    this.leases.set(lease.leaseId, lease);
    this.usage.set(authorization.authorizationId, []);
    this.persist();
    return { authorization: { ...authorization }, lease: this.publicLease(lease), credential };
  }

  delegate(parentCredential: string, agentId: string, allowance: number, ttlMs?: number): IssuedChildLease {
    const parent = this.authenticate(parentCredential);
    const authorization = this.getActiveAuthorization(parent.authorizationId);
    this.assertNotExpired(parent, authorization);
    const budget = this.budget(authorization.budgetName);

    if (parent.depth >= budget.maxDelegationDepth) {
      throw new SpendLimitExceededError(
        `Cannot delegate from lease ${parent.leaseId}: at max delegation depth (${budget.maxDelegationDepth})`
      );
    }

    const minViableAllowance = computeCost(
      cheapestModel(budget.allowedModels),
      budget.minRequestInputTokens,
      budget.minRequestOutputTokens
    );
    if (allowance < minViableAllowance) {
      throw new SpendLimitExceededError(
        `Cannot delegate $${allowance.toFixed(6)}: below this budget's minimum viable allowance ` +
          `$${minViableAllowance.toFixed(6)} (cheapest allowed model at ${budget.minRequestInputTokens}in/` +
          `${budget.minRequestOutputTokens}out tokens)`
      );
    }

    const delegated = [...this.leases.values()]
      .filter((lease) => lease.parentLeaseId === parent.leaseId && lease.status === 'active')
      .reduce((sum, lease) => sum + lease.allowance, 0);
    const available = parent.allowance - parent.spent - parent.pending - delegated;
    if (allowance <= 0 || allowance > available) {
      throw new SpendLimitExceededError(
        `Cannot delegate $${allowance.toFixed(4)} from lease ${parent.leaseId}: $${available.toFixed(4)} available`
      );
    }

    const credential = issueCredential();
    const requestedExpiry = new Date(Date.now() + (ttlMs ?? Date.parse(parent.expiresAt) - Date.now())).toISOString();
    const lease: InternalLease = {
      leaseId: randomUUID(),
      authorizationId: parent.authorizationId,
      parentLeaseId: parent.leaseId,
      agentId,
      allowance,
      spent: 0,
      pending: 0,
      status: 'active',
      expiresAt: requestedExpiry < parent.expiresAt ? requestedExpiry : parent.expiresAt,
      depth: parent.depth + 1,
      credentialHash: hashCredential(credential),
    };
    this.leases.set(lease.leaseId, lease);
    this.persist();
    return { lease: this.publicLease(lease), credential };
  }

  /** The generic primitive: atomic reserve/commit/cancel over any resource type, not just inference. */
  reserveAction(
    credential: string,
    actionType: ActionType,
    label: string,
    maximumCost: number,
    metadata: Record<string, unknown> = {}
  ): ActionReservation {
    const lease = this.authenticate(credential);
    const authorization = this.getActiveAuthorization(lease.authorizationId);
    this.assertNotExpired(lease, authorization);
    const leaseRemaining = lease.allowance - lease.spent - lease.pending;
    const taskRemaining = authorization.allowance - authorization.spent - authorization.pending;
    if (maximumCost <= 0 || maximumCost > leaseRemaining || maximumCost > taskRemaining) {
      throw new SpendLimitExceededError(
        `Action needs $${maximumCost.toFixed(4)}; lease has $${leaseRemaining.toFixed(4)} and task has $${taskRemaining.toFixed(4)}`
      );
    }

    const actionId = randomUUID();
    const reservation: ActionReservation = {
      reservationId: actionId,
      actionId,
      authorizationId: authorization.authorizationId,
      leaseId: lease.leaseId,
      actionType,
      label,
      maximumCost,
      estimatedCostUsd: maximumCost,
      status: 'reserved',
      metadata,
    };
    lease.pending += maximumCost;
    authorization.pending += maximumCost;
    this.reservations.set(reservation.reservationId, reservation);
    this.persist();
    return reservation;
  }

  commitAction(reservationId: string, actualCost: number, tokenUsage?: { inputTokens: number; outputTokens: number }): void {
    const reservation = this.getReservation(reservationId);
    if (actualCost > reservation.maximumCost + Number.EPSILON) {
      this.cancelAction(reservationId);
      throw new SpendLimitExceededError(
        `Actual cost $${actualCost.toFixed(4)} exceeded its preauthorized maximum $${reservation.maximumCost.toFixed(4)}`
      );
    }
    const lease = this.leases.get(reservation.leaseId)!;
    const authorization = this.authorizations.get(reservation.authorizationId)!;
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    lease.spent += actualCost;
    authorization.spent += actualCost;
    reservation.status = 'committed';
    this.usage.get(authorization.authorizationId)!.push({
      actionType: reservation.actionType,
      label: reservation.label,
      cost: actualCost,
      inputTokens: tokenUsage?.inputTokens,
      outputTokens: tokenUsage?.outputTokens,
    });
    this.reservations.delete(reservationId);
    this.persist();
  }

  cancelAction(reservationId: string): void {
    const reservation = this.getReservation(reservationId);
    const lease = this.leases.get(reservation.leaseId)!;
    const authorization = this.authorizations.get(reservation.authorizationId)!;
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    reservation.status = 'cancelled';
    this.reservations.delete(reservationId);
    this.persist();
  }

  /** Thin wrapper over reserveAction: adds the inference-specific allowedModels check. */
  reserveRequest(credential: string, model: string, maximumCost: number): ActionReservation {
    const lease = this.authenticate(credential);
    const authorization = this.getActiveAuthorization(lease.authorizationId);
    const policy = this.budget(authorization.budgetName);
    if (!policy.allowedModels.includes(model)) {
      throw new SpendLimitExceededError(`Model "${model}" is not allowed by Ramp budget ${authorization.rampBudgetId}`);
    }
    return this.reserveAction(credential, 'inference', model, maximumCost);
  }

  /** Thin wrapper over commitAction: records token counts alongside cost. */
  commitRequest(reservationId: string, inputTokens: number, outputTokens: number, actualCost: number): void {
    this.commitAction(reservationId, actualCost, { inputTokens, outputTokens });
  }

  cancelRequest(reservationId: string): void {
    this.cancelAction(reservationId);
  }

  async settleTask(
    authorizationId: string,
    outcome?: { status: TaskOutcomeStatus; evidence?: string; evidenceDetail?: OutcomeEvidence[] }
  ): Promise<TaskReceipt> {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0) throw new Error('Cannot settle a task with requests in flight');
    authorization.status = 'settled';
    const leases = [...this.leases.values()].filter((lease) => lease.authorizationId === authorizationId);
    leases.forEach((lease) => (lease.status = 'settled'));
    const events = this.usage.get(authorizationId) ?? [];
    const budget = this.budget(authorization.budgetName);
    const { modelUsage, actionUsage } = this.aggregateUsage(events);
    const receipt: TaskReceipt = {
      receiptId: randomUUID(),
      authorizationId,
      rampEntityId: this.config.rampEntityId,
      rampBudgetId: authorization.rampBudgetId,
      team: this.config.team,
      taskId: authorization.taskId,
      task: authorization.task,
      authorized: authorization.allowance,
      actual: authorization.spent,
      returned: authorization.allowance - authorization.spent,
      childAgents: leases.filter((lease) => lease.parentLeaseId).length,
      workerCount: leases.filter((lease) => lease.parentLeaseId).length,
      requestCount: events.length,
      actionCount: events.length,
      modelUsage,
      actionUsage,
      costs: computeCostBreakdown(actionUsage),
      costCenter: budget.costCenter,
      startedAt: authorization.createdAt,
      settledAt: new Date().toISOString(),
      outcome: outcome?.status ?? 'unknown',
      outcomeEvidence: outcome?.evidence,
      evidenceDetail: outcome?.evidenceDetail,
    };
    await this.ramp.reportTaskUsage(receipt);
    this.persist();
    return receipt;
  }

  /** Read-only, non-destructive - unlike settleTask(), doesn't close or settle anything. */
  getEvidenceSnapshot(authorizationId: string, requestedShortfall: number): TaskEvidenceSnapshot {
    const authorization = this.getActiveAuthorization(authorizationId);
    const childAgents = [...this.leases.values()].filter(
      (lease) => lease.authorizationId === authorizationId && lease.parentLeaseId
    ).length;
    const events = this.usage.get(authorizationId) ?? [];
    const { modelUsage } = this.aggregateUsage(events);

    return {
      task: authorization.task,
      allowance: authorization.allowance,
      spent: authorization.spent,
      pending: authorization.pending,
      requestCount: events.length,
      childAgents,
      elapsedSeconds: (Date.now() - Date.parse(authorization.createdAt)) / 1000,
      modelUsage,
      requestedShortfall,
    };
  }

  /** Scoped to exactly the blocked credential's lease - increases both its and the task's ceiling. */
  grantAdditionalAllowance(credential: string, amount: number): void {
    const lease = this.authenticate(credential);
    const authorization = this.getActiveAuthorization(lease.authorizationId);
    lease.allowance += amount;
    authorization.allowance += amount;
    this.persist();
  }

  getAuthorization(authorizationId: string): TaskAuthorization {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) throw new Error(`Unknown task authorization "${authorizationId}"`);
    return { ...authorization };
  }

  getAuthorizationForCredential(credential: string): TaskAuthorization {
    const lease = this.authenticate(credential);
    const authorization = this.getActiveAuthorization(lease.authorizationId);
    this.assertNotExpired(lease, authorization);
    return { ...authorization };
  }

  getLeaseForCredential(credential: string): InferenceLease {
    const lease = this.authenticate(credential);
    this.assertNotExpired(lease, this.getActiveAuthorization(lease.authorizationId));
    return this.publicLease(lease);
  }

  /** Shared by settleTask() and getEvidenceSnapshot(): modelUsage is inference-only (token-level detail); actionUsage rolls up every action type, inference included. */
  private aggregateUsage(events: ActionEvent[]): { modelUsage: ModelUsage[]; actionUsage: ActionUsage[] } {
    const byModel = new Map<string, ModelUsage>();
    const byActionType = new Map<ActionType, ActionUsage>();
    for (const event of events) {
      const actionAggregate = byActionType.get(event.actionType) ?? {
        actionType: event.actionType,
        count: 0,
        cost: 0,
      };
      actionAggregate.count += 1;
      actionAggregate.cost += event.cost;
      byActionType.set(event.actionType, actionAggregate);

      if (event.actionType === 'inference') {
        const modelAggregate = byModel.get(event.label) ?? {
          model: event.label,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
        modelAggregate.requests += 1;
        modelAggregate.inputTokens += event.inputTokens ?? 0;
        modelAggregate.outputTokens += event.outputTokens ?? 0;
        modelAggregate.cost += event.cost;
        byModel.set(event.label, modelAggregate);
      }
    }
    return { modelUsage: [...byModel.values()], actionUsage: [...byActionType.values()] };
  }

  revokeTask(authorizationId: string): void {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0) throw new Error('Cannot revoke a task with requests in flight');
    authorization.status = 'revoked';
    [...this.leases.values()]
      .filter((lease) => lease.authorizationId === authorizationId)
      .forEach((lease) => (lease.status = 'revoked'));
    this.persist();
  }

  private authenticate(credential: string): InternalLease {
    const candidate = hashCredential(credential);
    const lease = [...this.leases.values()].find(
      (item) => item.credentialHash.length === candidate.length && timingSafeEqual(item.credentialHash, candidate)
    );
    if (!lease || lease.status !== 'active') throw new InvalidCredentialError('Invalid or inactive task credential');
    return lease;
  }

  private getActiveAuthorization(authorizationId: string): TaskAuthorization {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization || authorization.status !== 'active') {
      throw new Error(`Task authorization "${authorizationId}" is not active`);
    }
    return authorization;
  }

  private assertNotExpired(lease: InternalLease, authorization: TaskAuthorization): void {
    if (Date.parse(lease.expiresAt) <= Date.now() || Date.parse(authorization.expiresAt) <= Date.now()) {
      lease.status = 'revoked';
      throw new InvalidCredentialError('Task credential has expired');
    }
  }

  private getReservation(reservationId: string): RequestReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Unknown request reservation "${reservationId}"`);
    return reservation;
  }

  private publicLease(lease: InternalLease): InferenceLease {
    const { credentialHash: _credentialHash, ...publicLease } = lease;
    return { ...publicLease };
  }
}
