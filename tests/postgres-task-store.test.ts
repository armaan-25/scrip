import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidCredentialError,
  PostgresTaskStore,
  SpendLimitExceededError,
} from '../src/infrastructure/postgres/postgres-task-store.js';

// Requires a real, reachable Postgres - see PGHOST/PGPORT/PGUSER/PGDATABASE
// env vars, or the defaults below, which match the project-local ephemeral
// instance started for this session (.pgdata-dev/, gitignored, not part of
// the repo). Skips instead of failing if nothing is listening, so `npm
// test` stays fully offline-runnable for everyone else - same "don't
// require infrastructure nobody has" principle as every other real-API
// test in this project being fakes-only.
//
// The availability probe runs as a top-level await, not inside beforeAll -
// describe.skipIf() evaluates its condition at collection time, before any
// beforeAll has run, so a flag only set inside beforeAll is always stale
// by the time skipIf reads it. This was a real bug caught by deliberately
// pointing PGPORT at nothing and watching every test fail with "store is
// undefined" instead of skipping cleanly.
const PG_CONFIG = {
  host: process.env.PGHOST ?? `${process.cwd()}/.pgdata-dev`,
  port: Number(process.env.PGPORT ?? 5488),
  user: process.env.PGUSER ?? 'postgres',
  database: process.env.PGDATABASE ?? 'scrip_dev',
};

const pool = new Pool(PG_CONFIG);
const pgAvailable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const store = new PostgresTaskStore(pool);
if (pgAvailable) await store.migrate();

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // Real tables, wiped between tests - same isolation intent as the
  // temp-dir-per-test pattern everywhere else, just for a real database.
  await pool.query('TRUNCATE action_reservations, leases, task_authorizations CASCADE');
});

describe.skipIf(!pgAvailable)('PostgresTaskStore', () => {
  async function authorize(allowance = 1) {
    return store.authorizeTask({
      budgetName: 'research',
      rampBudgetId: 'ramp-budget-research',
      taskId: 'task-1',
      task: 'Review a repository',
      allowance,
      ttlMs: 900_000,
    });
  }

  it('mints a task authorization and root lease with a real credential', async () => {
    const issued = await authorize(2);
    expect(issued.credential).toMatch(/^scrip_/);
    expect(issued.authorization.allowance).toBe(2);
    expect(issued.lease.agentId).toBe('root');
    expect(issued.lease.depth).toBe(0);
  });

  it('reserves, commits, and reduces spent/pending correctly', async () => {
    const issued = await authorize(1);
    const reservation = await store.reserveAction({
      credential: issued.credential,
      actionType: 'paid_api',
      label: 'vendor_api',
      maximumCost: 0.3,
    });
    expect(reservation.status).toBe('reserved');

    let authorization = await store.getAuthorization(issued.authorization.authorizationId);
    expect(authorization.pending).toBeCloseTo(0.3);

    await store.commitAction(reservation.reservationId, 0.21);
    authorization = await store.getAuthorization(issued.authorization.authorizationId);
    expect(authorization.pending).toBeCloseTo(0);
    expect(authorization.spent).toBeCloseTo(0.21);
  });

  it('cancelling a reservation releases its pending amount', async () => {
    const issued = await authorize(1);
    const reservation = await store.reserveAction({
      credential: issued.credential,
      actionType: 'paid_api',
      label: 'vendor_api',
      maximumCost: 0.3,
    });
    await store.cancelAction(reservation.reservationId);

    const authorization = await store.getAuthorization(issued.authorization.authorizationId);
    expect(authorization.pending).toBeCloseTo(0);
    expect(authorization.spent).toBeCloseTo(0);
  });

  it('rejects a reservation that exceeds the remaining balance', async () => {
    const issued = await authorize(0.1);
    await expect(
      store.reserveAction({ credential: issued.credential, actionType: 'paid_api', label: 'vendor_api', maximumCost: 0.5 })
    ).rejects.toThrow(SpendLimitExceededError);
  });

  it('rejects an invalid credential', async () => {
    await expect(
      store.reserveAction({ credential: 'scrip_not-real', actionType: 'paid_api', label: 'x', maximumCost: 0.1 })
    ).rejects.toThrow(InvalidCredentialError);
  });

  it('returns the same reservation for a reused idempotency key instead of double-reserving', async () => {
    const issued = await authorize(1);
    const first = await store.reserveAction({
      credential: issued.credential,
      actionType: 'paid_api',
      label: 'vendor_api',
      maximumCost: 0.3,
      idempotencyKey: 'retry-key-1',
    });
    const second = await store.reserveAction({
      credential: issued.credential,
      actionType: 'paid_api',
      label: 'vendor_api',
      maximumCost: 0.3,
      idempotencyKey: 'retry-key-1',
    });
    expect(second.reservationId).toBe(first.reservationId);

    const authorization = await store.getAuthorization(issued.authorization.authorizationId);
    expect(authorization.pending).toBeCloseTo(0.3); // not 0.6 - only reserved once
  });

  it(
    'two concurrent reservations racing for the same remaining balance: exactly one succeeds, never both - ' +
      'the real property an in-memory Map cannot offer across processes',
    async () => {
      // $0.6 allowance, two reservations of $0.4 each racing at the same
      // instant - together they oversubscribe by $0.2, so exactly one must
      // win. Real row locking (SELECT ... FOR UPDATE in reserveAction) is
      // what makes this deterministic instead of a race that occasionally
      // double-spends.
      const issued = await authorize(0.6);
      const attempt = () =>
        store.reserveAction({ credential: issued.credential, actionType: 'paid_api', label: 'vendor_api', maximumCost: 0.4 });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(SpendLimitExceededError);

      const authorization = await store.getAuthorization(issued.authorization.authorizationId);
      expect(authorization.pending).toBeCloseTo(0.4); // not 0.8 - the loser never touched the balance
    }
  );

  it('two separate Pool instances (simulating two separate processes) still can\'t jointly overspend', async () => {
    const poolB = new Pool(PG_CONFIG);
    const storeB = new PostgresTaskStore(poolB);
    try {
      const issued = await authorize(0.6);
      const [a, b] = await Promise.allSettled([
        store.reserveAction({ credential: issued.credential, actionType: 'paid_api', label: 'x', maximumCost: 0.4 }),
        storeB.reserveAction({ credential: issued.credential, actionType: 'paid_api', label: 'x', maximumCost: 0.4 }),
      ]);
      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    } finally {
      await poolB.end();
    }
  });
});
