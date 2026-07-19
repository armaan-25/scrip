import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RampBudgetConfig, ScripConfig } from './config.js';
import type { ModelUsage, RampGateway, TaskOutcomeStatus, TaskReceipt } from './store.js';

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
}

export interface IssuedTaskAuthorization {
  authorization: TaskAuthorization;
  lease: InferenceLease;
  credential: string;
}

export interface IssuedChildLease {
  lease: InferenceLease;
  credential: string;
}

export interface RequestReservation {
  reservationId: string;
  authorizationId: string;
  leaseId: string;
  model: string;
  maximumCost: number;
}

interface UsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface InternalLease extends InferenceLease {
  credentialHash: Buffer;
}

export class SpendLimitExceededError extends Error {}
export class InvalidCredentialError extends Error {}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential).digest();
}

function issueCredential(): string {
  return `scrip_${randomBytes(24).toString('base64url')}`;
}

export class TaskAuthorizationManager {
  private authorizations = new Map<string, TaskAuthorization>();
  private leases = new Map<string, InternalLease>();
  private reservations = new Map<string, RequestReservation>();
  private usage = new Map<string, UsageEvent[]>();

  constructor(private config: ScripConfig, private ramp: RampGateway) {}

  private budget(name: string): RampBudgetConfig {
    const budget = this.config.budgets[name];
    if (!budget) throw new Error(`Unknown Ramp budget "${name}"`);
    return budget;
  }

  getBudgetRemaining(name: string): number {
    const budget = this.budget(name);
    const reported = this.ramp.getReportedSpend(budget.rampBudgetId);
    const activeAllowances = [...this.authorizations.values()]
      .filter((authorization) => authorization.budgetName === name && authorization.status === 'active')
      .reduce((sum, authorization) => sum + authorization.allowance, 0);
    return budget.monthlyLimit - reported - activeAllowances;
  }

  authorizeTask(params: {
    budget: string;
    taskId: string;
    task: string;
    allowance: number;
    ttlMs?: number;
  }): IssuedTaskAuthorization {
    const budget = this.budget(params.budget);
    if (params.allowance <= 0 || params.allowance > budget.maxTaskAllowance) {
      throw new SpendLimitExceededError(
        `Task allowance must be between $0 and $${budget.maxTaskAllowance.toFixed(4)}`
      );
    }
    const remaining = this.getBudgetRemaining(params.budget);
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
      credentialHash: hashCredential(credential),
    };
    this.authorizations.set(authorization.authorizationId, authorization);
    this.leases.set(lease.leaseId, lease);
    this.usage.set(authorization.authorizationId, []);
    return { authorization: { ...authorization }, lease: this.publicLease(lease), credential };
  }

  delegate(parentCredential: string, agentId: string, allowance: number, ttlMs?: number): IssuedChildLease {
    const parent = this.authenticate(parentCredential);
    const authorization = this.getActiveAuthorization(parent.authorizationId);
    this.assertNotExpired(parent, authorization);
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
      credentialHash: hashCredential(credential),
    };
    this.leases.set(lease.leaseId, lease);
    return { lease: this.publicLease(lease), credential };
  }

  reserveRequest(credential: string, model: string, maximumCost: number): RequestReservation {
    const lease = this.authenticate(credential);
    const authorization = this.getActiveAuthorization(lease.authorizationId);
    this.assertNotExpired(lease, authorization);
    const policy = this.budget(authorization.budgetName);
    if (!policy.allowedModels.includes(model)) {
      throw new SpendLimitExceededError(`Model "${model}" is not allowed by Ramp budget ${authorization.rampBudgetId}`);
    }
    const leaseRemaining = lease.allowance - lease.spent - lease.pending;
    const taskRemaining = authorization.allowance - authorization.spent - authorization.pending;
    if (maximumCost <= 0 || maximumCost > leaseRemaining || maximumCost > taskRemaining) {
      throw new SpendLimitExceededError(
        `Request needs $${maximumCost.toFixed(4)}; lease has $${leaseRemaining.toFixed(4)} and task has $${taskRemaining.toFixed(4)}`
      );
    }

    const reservation: RequestReservation = {
      reservationId: randomUUID(),
      authorizationId: authorization.authorizationId,
      leaseId: lease.leaseId,
      model,
      maximumCost,
    };
    lease.pending += maximumCost;
    authorization.pending += maximumCost;
    this.reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  commitRequest(reservationId: string, inputTokens: number, outputTokens: number, actualCost: number): void {
    const reservation = this.getReservation(reservationId);
    if (actualCost > reservation.maximumCost + Number.EPSILON) {
      this.cancelRequest(reservationId);
      throw new SpendLimitExceededError(
        `Provider usage cost $${actualCost.toFixed(4)} exceeded its preauthorized maximum $${reservation.maximumCost.toFixed(4)}`
      );
    }
    const lease = this.leases.get(reservation.leaseId)!;
    const authorization = this.authorizations.get(reservation.authorizationId)!;
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    lease.spent += actualCost;
    authorization.spent += actualCost;
    this.usage.get(authorization.authorizationId)!.push({
      model: reservation.model,
      inputTokens,
      outputTokens,
      cost: actualCost,
    });
    this.reservations.delete(reservationId);
  }

  cancelRequest(reservationId: string): void {
    const reservation = this.getReservation(reservationId);
    const lease = this.leases.get(reservation.leaseId)!;
    const authorization = this.authorizations.get(reservation.authorizationId)!;
    lease.pending -= reservation.maximumCost;
    authorization.pending -= reservation.maximumCost;
    this.reservations.delete(reservationId);
  }

  settleTask(
    authorizationId: string,
    outcome?: { status: TaskOutcomeStatus; evidence?: string }
  ): TaskReceipt {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0) throw new Error('Cannot settle a task with requests in flight');
    authorization.status = 'settled';
    const leases = [...this.leases.values()].filter((lease) => lease.authorizationId === authorizationId);
    leases.forEach((lease) => (lease.status = 'settled'));
    const events = this.usage.get(authorizationId) ?? [];
    const budget = this.budget(authorization.budgetName);
    const byModel = new Map<string, ModelUsage>();
    for (const event of events) {
      const aggregate = byModel.get(event.model) ?? {
        model: event.model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      aggregate.requests += 1;
      aggregate.inputTokens += event.inputTokens;
      aggregate.outputTokens += event.outputTokens;
      aggregate.cost += event.cost;
      byModel.set(event.model, aggregate);
    }
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
      requestCount: events.length,
      modelUsage: [...byModel.values()],
      costCenter: budget.costCenter,
      startedAt: authorization.createdAt,
      settledAt: new Date().toISOString(),
      outcome: outcome?.status ?? 'unknown',
      outcomeEvidence: outcome?.evidence,
    };
    this.ramp.reportTaskUsage(receipt);
    return receipt;
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

  revokeTask(authorizationId: string): void {
    const authorization = this.getActiveAuthorization(authorizationId);
    if (authorization.pending > 0) throw new Error('Cannot revoke a task with requests in flight');
    authorization.status = 'revoked';
    [...this.leases.values()]
      .filter((lease) => lease.authorizationId === authorizationId)
      .forEach((lease) => (lease.status = 'revoked'));
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
