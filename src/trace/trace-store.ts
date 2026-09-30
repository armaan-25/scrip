/**
 * Append-only record of each purchase: what was asked, confirmed, understood,
 * chosen, paid, held, and decided. Same storage pattern as SqliteMissionStore.
 */
import { createRequire } from 'node:module';
import type { RecordedEvent, TraceEvent } from './events.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export class SqliteTraceStore {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS trace_events (
        trace_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (trace_id, seq)
      );
      CREATE TRIGGER IF NOT EXISTS trace_events_no_update BEFORE UPDATE ON trace_events
        BEGIN SELECT RAISE(ABORT, 'Trace events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trace_events_no_delete BEFORE DELETE ON trace_events
        BEGIN SELECT RAISE(ABORT, 'Trace events are append-only'); END;`);
  }

  append(traceId: string, event: TraceEvent, at: Date): RecordedEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM trace_events WHERE trace_id = ?').get(traceId) as { next: number };
      const recorded = { ...event, traceId, seq: row.next, at: at.toISOString() } as RecordedEvent;
      this.db.prepare('INSERT INTO trace_events VALUES (?, ?, ?, ?)').run(traceId, recorded.seq, recorded.at, JSON.stringify(event));
      this.db.exec('COMMIT');
      return recorded;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  events(traceId: string): RecordedEvent[] {
    const rows = this.db.prepare('SELECT seq, at, body FROM trace_events WHERE trace_id = ? ORDER BY seq').all(traceId) as { seq: number; at: string; body: string }[];
    return rows.map(r => ({ ...(JSON.parse(r.body) as TraceEvent), traceId, seq: r.seq, at: r.at }) as RecordedEvent);
  }

  /** Every trace id, oldest first. */
  traceIds(): string[] {
    const rows = this.db.prepare('SELECT trace_id, MIN(at) AS first FROM trace_events GROUP BY trace_id ORDER BY first').all() as { trace_id: string }[];
    return rows.map(r => r.trace_id);
  }

  exists(traceId: string): boolean {
    return this.db.prepare('SELECT 1 FROM trace_events WHERE trace_id = ? LIMIT 1').get(traceId) !== undefined;
  }

  close(): void { this.db.close(); }
}
