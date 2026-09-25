import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BudgetConfig, ScripConfig } from './config.js';
import type {
  ActionType,
  ActionUsage,
  FinanceGateway,
  OutcomeEvidence,
  TaskOutcomeStatus,
  TaskReceipt,
} from './store.js';

export type AuthorizationStatus = 'active' | 'settled' | 'revoked';

export interface TaskAuthorization {
  authorizationId: string;
  budgetName: string;
  budgetId: string;
  taskId: string;
  task: string;
  allowance: number;
  spent: number;
  pending: number;
  status: AuthorizationStatus;
  createdAt: string;
  expiresAt: string;
}

/** One agent's slice of a task authorization. The root lease is depth 0; delegate() issues children. */
export interface Lease {
  leaseId: string;
  authorizationId: string;
  parentLeaseId?: string;
  agentId: string;
  allowance: number;
  spent: number;
  pending: number;
  status: AuthorizationStatus;
  expiresAt: string;
  depth: number;
}

export interface IssuedTaskAuthorization {
  authorization: TaskAuthorization;
  lease: Lease;
  credential: string;
}

export interface IssuedChildLease {
  lease: Lease;
  credential: string;
}

export interface ActionReservation {
  reservationId: string;
  authorizationId: string;
  leaseId: string;
  actionType: ActionType;
  label: string;
  maximumCost: number;
  status: 'reserved' | 'committed' | 'cancelled';
  /** Free-form per-action detail (e.g. a purchase's merchant). Always an object. */
  metadata: Record<string, unknown>;
}

interface ActionEvent {
  actionType: ActionType;
  label: string;
  cost: number;
  leaseId: string;
}

interface InternalLease extends Lease {
  credentialHash: Buffer;
}

/** Serialized ledger state, persisted by a LeaseStateStore (the mission store keeps it in SQLite). */
export interface PersistedLeaseState {
  authorizations: TaskAuthorization[];
  leases: (Omit<InternalLease, 'credentialHash'> & { credentialHash: string })[];
  reservations: ActionReservation[];
  usage: Record<string, ActionEvent[]>;
}

export interface LeaseStateStore {
  load(): PersistedLeaseState | undefined;
  save(state: PersistedLeaseState): void;
}

export class SpendLimitExceededError extends Error {}
export class InvalidCredentialError extends Error {}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential).digest();
}

function issueCredential(): string {
  return `scrip_${randomBytes(24).toString('base64url')}`;
}

/**
 * The task ledger: one authorized allowance per task, attenuated leases for
 * delegated workers, and atomic reserve/commit/cancel accounting so
 * concurrent workers can never oversubscribe it. In-memory unless a
 * LeaseStateStore is supplied, in which case every mutation is saved.
 */
export class TaskAuthorizationManager {
  private authorizations = new Map<string, TaskAuthorization>();
  private leases = new Map<string, InternalLease>();
  private reservations = new Map<string, ActionReservation>();
  private usage = new Map<string, ActionEvent[]>();

  constructor(
    private config: ScripConfig,
    private finance: FinanceGateway,
    private stateStore?: LeaseStateStore
  ) {
    const data = this.stateStore?.load();
    if (data) {
      this.authorizations = new Map(data.authorizations.map((a) => [a.authorizationId, a]));
      this.leases = new Map(
        data.leases.map((l) => [l.leaseId, { ...l, credentialHash: Buffer.from(l.credentialHash, 'base64') }])
      );
      this.reservations = new Map(data.reservations.map((r) => [r.reservationId, r]));
      this.usage = new Map(Object.entries(data.usage));
    }
  }

  private persist(): void {
    this.stateStore?.save({
      authorizations: [...this.authorizations.values()],
      leases: [...this.leases.values()].map((l) => ({ ...l, credentialHash: l.credentialHash.toString('base64') })),
      reservations: [...this.reservations.values()],
      usage: Object.fromEntries(this.usage),
    });
  }

  private budget(name: string): BudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown budget "${name}"`);
    return budget;
  }

  private async getBudgetRemaining(name: string): Promise<number> {
    const budget = this.budget(name);
    const reported = await this.finance.getReportedSpend(budget.budgetId);
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
        `Cannot authorize $${params.allowance.toFixed(4)} from budget ${budget.budgetId}: ` +
          `$${remaining.toFixed(4)} remains`
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? budget.taskTtlSeconds * 1000)).toISOString();
    const authorization: TaskAuthorization = {
      authorizationId: randomUUID(),
      budgetName: params.budget,
      budgetId: budget.budgetId,
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

  /** Issues a child lease carved out of the parent's unspent, unreserved, undelegated allowance. */
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

  /** Holds maximumCost against both the lease and the task until commitAction or cancelAction resolves it. */
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

    const reservation: ActionReservation = {
      reservationId: randomUUID(),
      authorizationId: authorization.authorizationId,
      leaseId: lease.leaseId,
      actionType,
      label,
      maximumCost,
      status: 'reserved',
      metadata,
    };
    lease.pending += maximumCost;
    authorization.pending += maximumCost;
    this.reservations.set(reservation.reservationId, reservation);
    this.persist();
    return reservation;
  }

  commitAction(reservationId: string, actualCost: number): void {
    const reservation = this.getReservation(reservationId);
    if (actualCost > reservation.maximumCost + Number.EPSILON) {
      this.cancelAction(reservationId);
      throw new SpendLimitExceededError(
        `Actual cost $${actualCost.toFixed(4)} exceeded its preauthorized maximum $${reservation.maximumCost.toFixed(4)}`
      );
    }
    const { lease, authorization } = this.reservationOwners(reservation);
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    lease.spent += actualCost;
    authorization.spent += actualCost;
    reservation.status = 'committed';
    const events = this.usage.get(authorization.authorizationId) ?? [];
    events.push({ actionType: reservation.actionType, label: reservation.label, cost: actualCost, leaseId: lease.leaseId });
    this.usage.set(authorization.authorizationId, events);
    this.reservations.delete(reservationId);
    this.persist();
  }

  cancelAction(reservationId: string): void {
    const reservation = this.getReservation(reservationId);
    const { lease, authorization } = this.reservationOwners(reservation);
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    reservation.status = 'cancelled';
    this.reservations.delete(reservationId);
    this.persist();
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
    const receipt: TaskReceipt = {
      receiptId: randomUUID(),
      authorizationId,
      entityId: this.config.entityId,
      budgetId: authorization.budgetId,
      team: this.config.team,
      taskId: authorization.taskId,
      task: authorization.task,
      authorized: authorization.allowance,
      actual: authorization.spent,
      returned: authorization.allowance - authorization.spent,
      workerCount: leases.filter((lease) => lease.parentLeaseId).length,
      actionCount: events.length,
      actionUsage: aggregateByActionType(events),
      costCenter: this.budget(authorization.budgetName).costCenter,
      startedAt: authorization.createdAt,
      settledAt: new Date().toISOString(),
      outcome: outcome?.status ?? 'unknown',
      outcomeEvidence: outcome?.evidence,
      evidenceDetail: outcome?.evidenceDetail,
    };
    await this.finance.reportTaskUsage(receipt);
    this.persist();
    return receipt;
  }

  getAuthorization(authorizationId: string): TaskAuthorization {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) throw new Error(`Unknown task authorization "${authorizationId}"`);
    return { ...authorization };
  }

  /** Every lease under a task, root first, then by delegation depth. */
  getLeaseTree(authorizationId: string): Lease[] {
    return [...this.leases.values()]
      .filter((lease) => lease.authorizationId === authorizationId)
      .sort((a, b) => a.depth - b.depth)
      .map((lease) => this.publicLease(lease));
  }

  /**
   * Revokes the task and every lease under it. With preservePending, in-flight
   * reservations stay open so an operation already dispatched can still be
   * committed or cancelled against its original hold.
   */
  revokeTask(authorizationId: string, options: { preservePending?: boolean } = {}): void {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0 && !options.preservePending) throw new Error('Cannot revoke a task with requests in flight');
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

  private getReservation(reservationId: string): ActionReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Unknown reservation "${reservationId}"`);
    return reservation;
  }

  /** A reservation is only ever created against an existing lease and authorization, and neither is ever deleted. */
  private reservationOwners(reservation: ActionReservation): { lease: InternalLease; authorization: TaskAuthorization } {
    const lease = this.leases.get(reservation.leaseId);
    const authorization = this.authorizations.get(reservation.authorizationId);
    if (!lease || !authorization) throw new Error(`Reservation "${reservation.reservationId}" has no owning lease`);
    return { lease, authorization };
  }

  private publicLease(lease: InternalLease): Lease {
    const { credentialHash: _credentialHash, ...publicLease } = lease;
    return { ...publicLease };
  }
}

function aggregateByActionType(events: ActionEvent[]): ActionUsage[] {
  const byType = new Map<ActionType, ActionUsage>();
  for (const event of events) {
    const aggregate = byType.get(event.actionType) ?? { actionType: event.actionType, count: 0, cost: 0 };
    aggregate.count += 1;
    aggregate.cost += event.cost;
    byType.set(event.actionType, aggregate);
  }
  return [...byType.values()];
}
