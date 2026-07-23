import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SpendLimitExceededError extends Error {}
export class InvalidCredentialError extends Error {}

export interface PgTaskAuthorization {
  authorizationId: string;
  budgetName: string;
  rampBudgetId: string;
  taskId: string;
  task: string;
  allowance: number;
  spent: number;
  pending: number;
  status: 'active' | 'settled' | 'revoked';
  createdAt: string;
  expiresAt: string;
}

export interface PgLease {
  leaseId: string;
  authorizationId: string;
  parentLeaseId: string | null;
  agentId: string;
  allowance: number;
  spent: number;
  pending: number;
  status: 'active' | 'settled' | 'revoked';
  expiresAt: string;
  depth: number;
}

export interface PgActionReservation {
  reservationId: string;
  authorizationId: string;
  leaseId: string;
  actionType: string;
  label: string;
  maximumCost: number;
  status: 'reserved' | 'committed' | 'cancelled';
  metadata: Record<string, unknown>;
}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential).digest();
}

function issueCredential(): string {
  return `scrip_${randomBytes(24).toString('base64url')}`;
}

function toRow(row: any): any {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = value;
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * A real, durable, concurrency-safe implementation of the task/lease/action
 * primitive, backed by Postgres row locking and transactions - the piece
 * TaskAuthorizationManager's in-memory Maps genuinely cannot provide:
 * "two independent processes must not reserve the same remaining
 * allowance" (docs/PIVOT_AUDIT.md Phase 3). Deliberately NOT wired in as
 * TaskAuthorizationManager's backend - that's a larger, separate
 * integration (TaskAuthorizationManager's public API is synchronous in
 * several places; a real swap would need to either make every caller
 * async or keep an in-memory read-through cache, both real design
 * decisions this class doesn't make unilaterally). This class stands on
 * its own, proves the concurrency invariant with a real two-connection
 * race test (tests/postgres-task-store.test.ts), and is the store a
 * future TaskAuthorizationManager-backed-by-Postgres integration would
 * build on.
 */
export class PostgresTaskStore {
  constructor(private pool: Pool) {}

  async migrate(): Promise<void> {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await this.pool.query(schema);
  }

  async authorizeTask(params: {
    budgetName: string;
    rampBudgetId: string;
    taskId: string;
    task: string;
    allowance: number;
    ttlMs: number;
  }): Promise<{ authorization: PgTaskAuthorization; lease: PgLease; credential: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authorizationId = randomUUID();
      const leaseId = randomUUID();
      const credential = issueCredential();
      const expiresAt = new Date(Date.now() + params.ttlMs);

      const authRow = await client.query(
        `INSERT INTO task_authorizations
           (authorization_id, budget_name, ramp_budget_id, task_id, task, allowance, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [authorizationId, params.budgetName, params.rampBudgetId, params.taskId, params.task, params.allowance, expiresAt]
      );
      const leaseRow = await client.query(
        `INSERT INTO leases
           (lease_id, authorization_id, parent_lease_id, agent_id, allowance, expires_at, depth, credential_hash)
         VALUES ($1, $2, NULL, 'root', $3, $4, 0, $5)
         RETURNING *`,
        [leaseId, authorizationId, params.allowance, expiresAt, hashCredential(credential)]
      );
      await client.query('COMMIT');

      return {
        authorization: mapAuthorization(authRow.rows[0]),
        lease: mapLease(leaseRow.rows[0]),
        credential,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The core concurrency-safety guarantee. `SELECT ... FOR UPDATE` takes a
   * row lock on both the lease and the authorization for the duration of
   * this transaction - a second, concurrent reserveAction() against either
   * row blocks until this one commits or rolls back, so two callers racing
   * for the same remaining balance can never both succeed when only one
   * of them actually fits. This is the property a plain in-memory Map,
   * shared only within one Node process, cannot offer across processes.
   */
  async reserveAction(params: {
    credential: string;
    actionType: string;
    label: string;
    maximumCost: number;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<PgActionReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (params.idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM action_reservations WHERE metadata->>'idempotencyKey' = $1`,
          [params.idempotencyKey]
        );
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          return mapReservation(existing.rows[0]);
        }
      }

      const leaseResult = await client.query(
        `SELECT * FROM leases WHERE credential_hash = $1 AND status = 'active' FOR UPDATE`,
        [hashCredential(params.credential)]
      );
      if (leaseResult.rows.length === 0) {
        throw new InvalidCredentialError('Invalid or inactive task credential');
      }
      const lease = leaseResult.rows[0];

      const authResult = await client.query(
        `SELECT * FROM task_authorizations WHERE authorization_id = $1 AND status = 'active' FOR UPDATE`,
        [lease.authorization_id]
      );
      if (authResult.rows.length === 0) {
        throw new Error(`Task authorization "${lease.authorization_id}" is not active`);
      }
      const authorization = authResult.rows[0];

      const leaseRemaining = num(lease.allowance) - num(lease.spent) - num(lease.pending);
      const taskRemaining = num(authorization.allowance) - num(authorization.spent) - num(authorization.pending);
      if (params.maximumCost <= 0 || params.maximumCost > leaseRemaining || params.maximumCost > taskRemaining) {
        throw new SpendLimitExceededError(
          `Action needs $${params.maximumCost.toFixed(4)}; lease has $${leaseRemaining.toFixed(4)} and task has $${taskRemaining.toFixed(4)}`
        );
      }

      const reservationId = randomUUID();
      const metadata = { ...(params.metadata ?? {}), ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}) };
      const reservationRow = await client.query(
        `INSERT INTO action_reservations
           (reservation_id, authorization_id, lease_id, action_type, label, maximum_cost, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [reservationId, lease.authorization_id, lease.lease_id, params.actionType, params.label, params.maximumCost, metadata]
      );
      await client.query(`UPDATE leases SET pending = pending + $1 WHERE lease_id = $2`, [params.maximumCost, lease.lease_id]);
      await client.query(`UPDATE task_authorizations SET pending = pending + $1 WHERE authorization_id = $2`, [
        params.maximumCost,
        lease.authorization_id,
      ]);

      await client.query('COMMIT');
      return mapReservation(reservationRow.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async commitAction(reservationId: string, actualCost: number, tokenUsage?: { inputTokens: number; outputTokens: number }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const reservation = await this.lockReservation(client, reservationId);

      if (actualCost > num(reservation.maximum_cost) + Number.EPSILON) {
        await this.releaseReservation(client, reservation, 'cancelled');
        await client.query('COMMIT');
        throw new SpendLimitExceededError(
          `Actual cost $${actualCost.toFixed(4)} exceeded its preauthorized maximum $${num(reservation.maximum_cost).toFixed(4)}`
        );
      }

      await client.query(`UPDATE leases SET pending = pending - $1, spent = spent + $2 WHERE lease_id = $3`, [
        reservation.maximum_cost,
        actualCost,
        reservation.lease_id,
      ]);
      await client.query(
        `UPDATE task_authorizations SET pending = pending - $1, spent = spent + $2 WHERE authorization_id = $3`,
        [reservation.maximum_cost, actualCost, reservation.authorization_id]
      );
      await client.query(
        `UPDATE action_reservations
         SET status = 'committed', actual_cost = $1, input_tokens = $2, output_tokens = $3, resolved_at = now()
         WHERE reservation_id = $4`,
        [actualCost, tokenUsage?.inputTokens ?? null, tokenUsage?.outputTokens ?? null, reservationId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelAction(reservationId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const reservation = await this.lockReservation(client, reservationId);
      await this.releaseReservation(client, reservation, 'cancelled');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockReservation(client: PoolClient, reservationId: string) {
    const result = await client.query(`SELECT * FROM action_reservations WHERE reservation_id = $1 FOR UPDATE`, [
      reservationId,
    ]);
    if (result.rows.length === 0) throw new Error(`Unknown request reservation "${reservationId}"`);
    if (result.rows[0].status !== 'reserved') {
      throw new Error(`Reservation "${reservationId}" is already ${result.rows[0].status}`);
    }
    return result.rows[0];
  }

  private async releaseReservation(client: PoolClient, reservation: any, status: 'cancelled'): Promise<void> {
    await client.query(`UPDATE leases SET pending = pending - $1 WHERE lease_id = $2`, [
      reservation.maximum_cost,
      reservation.lease_id,
    ]);
    await client.query(`UPDATE task_authorizations SET pending = pending - $1 WHERE authorization_id = $2`, [
      reservation.maximum_cost,
      reservation.authorization_id,
    ]);
    await client.query(`UPDATE action_reservations SET status = $1, resolved_at = now() WHERE reservation_id = $2`, [
      status,
      reservation.reservation_id,
    ]);
  }

  async getAuthorization(authorizationId: string): Promise<PgTaskAuthorization> {
    const result = await this.pool.query(`SELECT * FROM task_authorizations WHERE authorization_id = $1`, [authorizationId]);
    if (result.rows.length === 0) throw new Error(`Unknown task authorization "${authorizationId}"`);
    return mapAuthorization(result.rows[0]);
  }
}

function mapAuthorization(row: any): PgTaskAuthorization {
  const mapped = toRow(row) as any;
  return {
    ...mapped,
    allowance: num(mapped.allowance),
    spent: num(mapped.spent),
    pending: num(mapped.pending),
    createdAt: new Date(mapped.createdAt).toISOString(),
    expiresAt: new Date(mapped.expiresAt).toISOString(),
  };
}

function mapLease(row: any): PgLease {
  const mapped = toRow(row) as any;
  return {
    ...mapped,
    allowance: num(mapped.allowance),
    spent: num(mapped.spent),
    pending: num(mapped.pending),
    expiresAt: new Date(mapped.expiresAt).toISOString(),
  };
}

function mapReservation(row: any): PgActionReservation {
  const mapped = toRow(row) as any;
  return {
    reservationId: mapped.reservationId,
    authorizationId: mapped.authorizationId,
    leaseId: mapped.leaseId,
    actionType: mapped.actionType,
    label: mapped.label,
    maximumCost: num(mapped.maximumCost),
    status: mapped.status,
    metadata: mapped.metadata ?? {},
  };
}

