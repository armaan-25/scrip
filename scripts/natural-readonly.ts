/**
 * Read-only look at the Natural account behind NATURAL_API_KEY: party,
 * wallets, recent transactions, agents. Prints ids and balances only.
 * Never creates, moves, or changes anything.
 *
 * Run: npx tsx scripts/natural-readonly.ts
 */
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

import { NaturalClient } from '@naturalpay/sdk';

if (!process.env.NATURAL_API_KEY) {
  console.error('NATURAL_API_KEY is not set');
  process.exit(2);
}

const client = new NaturalClient({ instanceId: 'scrip-protect-readonly' });

// Responses follow JSON:API: { data: { id, type, attributes } } for one,
// { data: [...] } for many. Paged lists are async-iterable in this SDK.
type Any = Record<string, unknown> & { id?: string; attributes?: Record<string, unknown> };
const pick = (item: Any, keys: string[]) =>
  Object.fromEntries([['id', item.id], ...keys.map(k => [k, item.attributes?.[k] ?? item[k]])]);

const party = (await client.parties.get()) as unknown as { data: Any };
console.log('party      ', JSON.stringify(pick(party.data, ['handle', 'displayName', 'status', 'partyType'])));

const wallets = (await client.wallets.list()) as unknown as { data: Any[] | Any };
const walletItems = Array.isArray(wallets.data) ? wallets.data : [wallets.data];
console.log('wallets    ', JSON.stringify(walletItems.map(w => pick(w, ['displayName', 'name', 'type', 'status', 'balance', 'isDefault']))));

const transactions: Any[] = [];
for await (const t of (await client.transactions.list({})) as unknown as AsyncIterable<Any>) {
  transactions.push(pick(t, ['amount', 'currency', 'status', 'direction', 'transactionType', 'description']));
  if (transactions.length >= 5) break;
}
console.log('transactions', JSON.stringify(transactions));

const agents: Any[] = [];
for await (const a of (await client.agents.list({})) as unknown as AsyncIterable<Any>) {
  agents.push(pick(a, ['name', 'handle', 'status', 'limits']));
}
console.log('agents     ', JSON.stringify(agents));
