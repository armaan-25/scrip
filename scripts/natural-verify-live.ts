/**
 * Read-only verification of the live protect demo against Natural's own
 * records: wallet balances and the most recent internal transfers with
 * their Scrip tags. Never creates, moves, or changes anything.
 *
 * Run: npx tsx scripts/natural-verify-live.ts
 */
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

import { NaturalClient } from '@naturalpay/sdk';

type Any = Record<string, unknown> & { id?: string; attributes?: Record<string, unknown> };

const client = new NaturalClient({ instanceId: 'scrip-verify-readonly' });

const wallets = (await client.wallets.list()) as unknown as { data: Any[] | Any };
const items = Array.isArray(wallets.data) ? wallets.data : [wallets.data];
for (const w of items) {
  console.log('wallet ', w.id, String(w.attributes?.displayName).padEnd(32), JSON.stringify(w.attributes?.balance));
}

const rows: string[] = [];
for await (const t of (await client.transfers.list({})) as unknown as AsyncIterable<Any>) {
  const a = t.attributes ?? {};
  const tags = (a.tags ?? {}) as Record<string, string>;
  rows.push([
    String(t.id), String(a.status).padEnd(10), String(a.amount).padStart(4) + 'c',
    (tags.scrip_kind ?? tags.scrip_role ?? '').padEnd(10), (tags.scrip_purchase_digest ?? '').slice(0, 12).padEnd(12),
    String(a.createdAt),
  ].join('  '));
  if (rows.length >= 12) break;
}
console.log('transfers, newest first (id  status  amount  scrip tag  purchase digest  created):');
for (const r of rows) console.log('  ' + r);
