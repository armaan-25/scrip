/**
 * Any purchase task, not just flights. The person types a task, then
 * confirms a budget and plain-language must-haves. The agent checks out one
 * item; Scrip decides:
 *
 *   rejected   over budget, or the checker says a must-have is not met
 *   in_review  the price never appeared in anything the agent read, the page
 *              it cites is one it never opened or saw, or the checker is unsure
 *   accepted   otherwise
 *
 * Budget, "price seen", and "page seen" are exact checks in code. Must-haves
 * are plain words, so a separate AI checker (judge.ts) answers each one; its
 * answers are recorded so the checker itself can be audited.
 */
import { priceAppears } from '../agent/source-check.js';

export interface PurchaseTask { words: string; budgetCents: number; musts: string[] }
export interface PurchaseItem { merchant: string; item: string; details: string; quantity: number; totalCents: number; url: string }
export interface MustCheck { must: string; verdict: 'yes' | 'no' | 'unsure'; reason: string }
export type PurchaseDecision = 'accepted' | 'rejected' | 'in_review';
export interface PurchaseVerdict { decision: PurchaseDecision; blockerDecision: PurchaseDecision; reasons: string[]; priceSeen: boolean; pageSeen: boolean }

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** A page counts as seen if the agent opened it, or its address appeared in results it read. Query strings are ignored. */
export function pageSeen(url: string, openedUrls: string[], research: string): boolean {
  const key = (u: string): string => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return u; } };
  const target = key(url);
  return openedUrls.some(u => key(u) === target) || research.includes(target) || research.includes(url);
}

export function decidePurchase(
  task: PurchaseTask, item: PurchaseItem, research: string, openedUrls: string[], checks: MustCheck[], mode: 'blocker' | 'observer',
): PurchaseVerdict {
  const priceSeen = priceAppears(research, item.totalCents);
  const seen = pageSeen(item.url, openedUrls, research);
  const rejected = [
    ...(item.totalCents > task.budgetCents ? [`${usd(item.totalCents)} is over the ${usd(task.budgetCents)} budget`] : []),
    ...checks.filter(c => c.verdict === 'no').map(c => `must-have not met: ${c.must} (${c.reason})`),
  ];
  const review = [
    ...(priceSeen ? [] : [`${usd(item.totalCents)} never appeared in anything the agent read`]),
    ...(seen ? [] : ['the agent never opened or saw the page it cites']),
    ...checks.filter(c => c.verdict === 'unsure').map(c => `checker unsure: ${c.must} (${c.reason})`),
  ];
  const blockerDecision: PurchaseDecision = rejected.length ? 'rejected' : review.length ? 'in_review' : 'accepted';
  return { decision: mode === 'blocker' ? blockerDecision : 'accepted', blockerDecision, reasons: rejected.length ? rejected : review, priceSeen, pageSeen: seen };
}

/** Parse the agent's checkout arguments at the boundary, or say what is wrong. */
export function parseItem(a: Record<string, unknown>): PurchaseItem | string {
  const merchant = String(a.merchant ?? '').trim();
  const item = String(a.item ?? '').trim();
  const url = String(a.url ?? '');
  const totalUsd = Number(a.totalUsd);
  const quantity = a.quantity === undefined ? 1 : Number(a.quantity);
  if (!merchant || !item) return 'merchant and item are required';
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 'totalUsd must be the positive total price in USD';
  if (!Number.isInteger(quantity) || quantity < 1) return 'quantity must be a whole number, 1 or more';
  if (!/^https?:\/\//.test(url)) return 'url must be the http(s) page where you found this item and price';
  return { merchant: merchant.slice(0, 60), item: item.slice(0, 160), details: String(a.details ?? '').slice(0, 600), quantity, totalCents: Math.round(totalUsd * 100), url };
}
