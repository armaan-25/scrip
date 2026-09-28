import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nonstopOffer } from '../src/flights/fixtures.js';
import { orderFingerprint } from '../src/trace/fingerprint.js';
import { SqliteTraceStore } from '../src/trace/trace-store.js';

let dir: string;
let store: SqliteTraceStore;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-trace-')); store = new SqliteTraceStore(path.join(dir, 'trace.sqlite')); });
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('orderFingerprint', () => {
  it('ignores key order and changes when any field changes', () => {
    const reordered = Object.fromEntries(Object.entries(nonstopOffer).reverse());
    expect(orderFingerprint(reordered)).toBe(orderFingerprint(nonstopOffer));
    expect(orderFingerprint({ ...nonstopOffer, totalCents: 55901 })).not.toBe(orderFingerprint(nonstopOffer));
    expect(orderFingerprint(nonstopOffer)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('SqliteTraceStore', () => {
  const at = new Date('2026-09-28T12:00:00Z');

  it('appends events in order per trace', () => {
    store.append('trc_a', { type: 'request_received', data: { consumerId: 'p', words: 'hi' } }, at);
    store.append('trc_b', { type: 'request_received', data: { consumerId: 'p', words: 'other' } }, at);
    store.append('trc_a', { type: 'interpretation_compared', data: { differences: [] } }, at);
    expect(store.events('trc_a').map(e => [e.seq, e.type])).toEqual([[1, 'request_received'], [2, 'interpretation_compared']]);
    expect(store.exists('trc_b')).toBe(true);
    expect(store.exists('trc_missing')).toBe(false);
  });

  it('refuses to edit or delete recorded events', () => {
    store.append('trc_a', { type: 'request_received', data: { consumerId: 'p', words: 'hi' } }, at);
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => db.exec("UPDATE trace_events SET body = '{}'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM trace_events')).toThrow(/append-only/);
  });
});
