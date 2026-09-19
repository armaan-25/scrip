import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { LeaseStateStore, PersistedLeaseState } from '../lease.js';
import type { TaskReceipt } from '../store.js';
import { canonical, paymentTotals } from './outcome-assessor.js';
import type { MissionEvent, MissionEventInput, PurchaseMission } from './types.js';

export class MissionConflictError extends Error {}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function projectMission(events: MissionEvent[]): PurchaseMission {
  const first = events[0];
  if (!first || first.type !== 'contract_created') throw new Error('Unknown mission');
  const mission: PurchaseMission = {
    missionId: first.missionId, consumerId: first.data.consumerId, status: 'draft', revision: events.length,
    contract: structuredClone(first.data.contract), contracts: [], revoked: false,
    createdAt: first.occurredAt, updatedAt: events.at(-1)!.occurredAt,
  };
  for (const event of events) {
    switch (event.type) {
      case 'contract_created': break;
      case 'contract_revised':
        mission.contracts.push(structuredClone(mission.contract));
        mission.contract = structuredClone(event.data.contract);
        mission.status = 'draft';
        break;
      case 'consumer_approved': mission.contract.approvalEvidence = event.data; mission.status = 'authorized'; break;
      case 'execution_started':
        mission.operation = { ...event.data }; mission.authorizationId = event.data.authorizationId;
        mission.status = 'executing'; break;
      case 'credential_issued': if (mission.operation) mission.operation.capabilityRef = event.data.capabilityRef; break;
      case 'execution_observed': if (mission.operation) mission.operation.executionRef = event.data.executionRef; break;
      case 'operation_pending': mission.status = 'outcome_pending'; break;
      case 'payment_observed':
        if (event.data.kind === 'refund_acknowledged') mission.status = 'recovering';
        break;
      case 'outcome_assessed':
        if (event.data.status === 'success') mission.status = 'succeeded';
        else if (event.data.status === 'failure') {
          mission.status = mission.contract.recoveryPolicy.allowMerchantCancellation || mission.contract.recoveryPolicy.allowMerchantRefundRequest
            ? 'recovery_required' : 'unrecoverable';
        } else mission.status = 'outcome_pending';
        break;
      case 'recovery_requested': case 'refund_pending': mission.status = 'recovering'; break;
      case 'mission_revoked': mission.revoked = true; break;
    }
  }
  const { captured, refunded, reversed } = paymentTotals(events);
  if (refunded + reversed > 0) mission.status = refunded + reversed >= captured ? 'refunded' : 'partially_recovered';
  else if (events.some(event => event.type === 'recovery_requested'
    || (event.type === 'payment_observed' && event.data.kind === 'refund_acknowledged'))
    && mission.status !== 'unrecoverable') mission.status = 'recovering';
  if (mission.revoked && !['refunded', 'partially_recovered'].includes(mission.status)) mission.status = 'cancelled';
  return structuredClone(mission);
}

export class SqliteMissionStore {
  private db: InstanceType<typeof DatabaseSync>;
  private inTransaction = false;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS mission_events (
        mission_id TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL, external_id TEXT, body TEXT NOT NULL,
        PRIMARY KEY (mission_id, revision), UNIQUE (source, external_id)
      );
      CREATE TABLE IF NOT EXISTS mission_operations (
        operation_key TEXT PRIMARY KEY, mission_id TEXT NOT NULL, contract_version INTEGER NOT NULL,
        operation TEXT NOT NULL, UNIQUE(mission_id, contract_version, operation)
      );
      CREATE TABLE IF NOT EXISTS lease_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mission_task_receipts (authorization_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON mission_events
        BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON mission_events
        BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;`);
  }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.inTransaction) throw new MissionConflictError('Mission store busy; retry the same request');
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch { throw new MissionConflictError('Mission store busy; retry the same request'); }
    this.inTransaction = true;
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.inTransaction = false; }
  }

  private requireTransaction(): void {
    if (!this.inTransaction) throw new Error('Mission write requires a transaction');
  }

  events(missionId: string): MissionEvent[] {
    return this.db.prepare('SELECT body FROM mission_events WHERE mission_id = ? ORDER BY revision').all(missionId)
      .map(row => JSON.parse(row.body as string));
  }

  get(missionId: string): PurchaseMission { return projectMission(this.events(missionId)); }

  append(missionId: string, input: MissionEventInput, expectedVersion: number, now: Date): boolean {
    this.requireTransaction();
    if (input.externalId) {
      const row = this.db.prepare('SELECT body FROM mission_events WHERE source = ? AND external_id = ?').get(input.source, input.externalId);
      if (row) {
        const old: MissionEvent = JSON.parse(row.body as string);
        if (old.missionId !== missionId || old.type !== input.type || canonical(old.data) !== canonical(input.data)) {
          throw new MissionConflictError('External evidence ID reused with different facts');
        }
        return false;
      }
    }
    if (this.events(missionId).length !== expectedVersion) throw new MissionConflictError('Mission version changed');
    const event: MissionEvent = { ...input, missionId, eventId: randomUUID(), occurredAt: now.toISOString() };
    this.db.prepare('INSERT INTO mission_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(missionId, expectedVersion + 1, event.eventId, input.source, input.externalId ?? null, JSON.stringify(event));
    return true;
  }

  claimOperation(key: string, missionId: string, version: number, operation: string): boolean {
    this.requireTransaction();
    return this.db.prepare('INSERT OR IGNORE INTO mission_operations VALUES (?, ?, ?, ?)')
      .run(key, missionId, version, operation).changes === 1;
  }

  leaseStateStore(): LeaseStateStore {
    this.requireTransaction();
    return {
      load: () => {
        this.requireTransaction();
        const row = this.db.prepare('SELECT body FROM lease_state WHERE id = 1').get();
        return row ? JSON.parse(row.body as string) as PersistedLeaseState : undefined;
      },
      save: state => {
        this.requireTransaction();
        this.db.prepare('INSERT INTO lease_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body')
          .run(JSON.stringify(state));
      },
    };
  }

  saveTaskReceipt(receipt: TaskReceipt): void {
    this.requireTransaction();
    this.db.prepare('INSERT INTO mission_task_receipts VALUES (?, ?)').run(receipt.authorizationId, JSON.stringify(receipt));
  }

  getTaskReceipt(authorizationId: string): TaskReceipt | undefined {
    const row = this.db.prepare('SELECT body FROM mission_task_receipts WHERE authorization_id = ?').get(authorizationId);
    return row ? JSON.parse(row.body as string) : undefined;
  }

  reportedSpend(rampBudgetId: string): number {
    const month = new Date().toISOString().slice(0, 7);
    const settled = this.db.prepare('SELECT body FROM mission_task_receipts').all()
      .map(row => JSON.parse(row.body as string) as TaskReceipt)
      .filter(receipt => receipt.rampBudgetId === rampBudgetId && receipt.settledAt.startsWith(month))
      .reduce((total, receipt) => total + receipt.actual, 0);
    const row = this.db.prepare('SELECT body FROM lease_state WHERE id = 1').get();
    const state: PersistedLeaseState | undefined = row ? JSON.parse(row.body as string) : undefined;
    const revoked = state?.authorizations.filter(auth => auth.rampBudgetId === rampBudgetId && auth.status === 'revoked')
      .reduce((total, auth) => total + auth.pending + (auth.createdAt.startsWith(month) ? auth.spent : 0), 0) ?? 0;
    return settled + revoked;
  }

  close(): void { this.db.close(); }
}
