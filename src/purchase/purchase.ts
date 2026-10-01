/**
 * Any purchase task, not just flights. The person types a task, then
 * confirms a budget and plain-language must-haves. The agent checks out one
 * item; Scrip decides:
 *
 *   rejected   over budget, or the checker says a must-have is not met
 *   in_review  the agent never saw the price on the page it is buying from
 *              (only in search results, or the page showed no price), or the
 *              checker is unsure
 *   accepted   otherwise
 *
 * Budget and "price on the cited page" are exact checks in code. Must-haves
 * are plain words, so a separate AI checker (judge.ts) answers each one; its
 * answers are recorded so the checker itself can be audited.
 */
import { priceAppears } from '../agent/source-check.js';

export interface PurchaseTask { words: string; budgetCents: number; musts: string[] }
export interface PurchaseItem { merchant: string; item: string; details: string; quantity: number; totalCents: number; url: string; /** Size, color, or other option as the store names it. */ option?: string }
export interface MustCheck { must: string; verdict: 'yes' | 'no' | 'unsure'; reason: string }
export type PurchaseDecision = 'accepted' | 'rejected' | 'in_review';
export interface PurchaseVerdict {
  decision: PurchaseDecision; blockerDecision: PurchaseDecision; reasons: string[];
  /** Price appeared anywhere the agent read; page appeared in results or was opened; price appeared on the opened page itself. */
  priceSeen: boolean; pageSeen: boolean; pageOpened: boolean; priceOnPage: boolean;
}
/** What the agent got back when it opened the page it cites (null if it never opened it successfully). */
export type CitedPage = { text: string } | null;

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** A page counts as seen if the agent opened it, or its address appeared in results it read. Query strings are ignored. */
export function pageSeen(url: string, openedUrls: string[], research: string): boolean {
  const key = (u: string): string => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return u; } };
  const target = key(url);
  return openedUrls.some(u => key(u) === target) || research.includes(target) || research.includes(url);
}

export function decidePurchase(
  task: PurchaseTask, item: PurchaseItem, research: string, cited: CitedPage, checks: MustCheck[], mode: 'blocker' | 'observer',
): PurchaseVerdict {
  const priceSeen = priceAppears(research, item.totalCents);
  const pageOpened = cited !== null;
  const priceOnPage = cited !== null && priceAppears(cited.text, item.totalCents);
  const seen = pageOpened || pageSeen(item.url, [], research);
  const price = usd(item.totalCents);
  const rejected = [
    ...(item.totalCents > task.budgetCents ? [`${usd(item.totalCents)} is over the ${usd(task.budgetCents)} budget`] : []),
    ...checks.filter(c => c.verdict === 'no').map(c => `must-have not met: ${c.must} (${c.reason})`),
  ];
  const review = [
    ...(!priceSeen ? [`${price} never appeared in anything the agent read`]
      : priceOnPage ? []
      : pageOpened ? [`the page it is buying from does not show ${price}; it saw that price only in search results`]
      : [`it never opened the page it is buying from; ${price} came from search results only`]),
    ...checks.filter(c => c.verdict === 'unsure').map(c => `checker unsure: ${c.must} (${c.reason})`),
  ];
  const blockerDecision: PurchaseDecision = rejected.length ? 'rejected' : review.length ? 'in_review' : 'accepted';
  return { decision: mode === 'blocker' ? blockerDecision : 'accepted', blockerDecision, reasons: rejected.length ? rejected : review, priceSeen, pageSeen: seen, pageOpened, priceOnPage };
}

/** A search, category, or collection page lists many items; a merchant can only price one product page. */
export function looksLikeListing(url: string): boolean {
  try {
    const u = new URL(url);
    return /\/(collections|category|categories|search|s|c|browse|shop)(\/[^/]*)?\/?$/i.test(u.pathname) || u.searchParams.has('q') || u.searchParams.has('k');
  } catch { return false; }
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
  if (looksLikeListing(url)) return "url is a search, category, or collection page. Open the item's own product page and check out with that URL.";
  const option = typeof a.option === 'string' && a.option.trim() ? a.option.trim().slice(0, 80) : undefined;
  return { merchant: merchant.slice(0, 60), item: item.slice(0, 160), details: String(a.details ?? '').slice(0, 600), quantity, totalCents: Math.round(totalUsd * 100), url, ...(option ? { option } : {}) };
}

/**
 * Final decision once the merchant has answered. Merchant order details are
 * the trusted source: when the merchant priced the order, its fingerprint
 * must match the approved order (any difference is rejected), and the
 * agent-side evidence checks no longer matter. When the merchant sent no
 * order details, nothing independent confirms the purchase, so Blocker holds
 * it for review with the agent-side reasons attached.
 */
export function decideWithMerchant(
  verdict: PurchaseVerdict, merchant: { status: 'priced'; match: boolean; differences: string[] } | { status: 'unavailable'; reason: string }, mode: 'blocker' | 'observer',
): Pick<PurchaseVerdict, 'decision' | 'blockerDecision' | 'reasons'> {
  let blockerDecision: PurchaseDecision;
  let reasons: string[];
  if (verdict.blockerDecision === 'rejected') {
    blockerDecision = 'rejected'; reasons = verdict.reasons;
  } else if (merchant.status === 'priced') {
    const unsure = verdict.reasons.filter(r => r.startsWith('checker unsure'));
    if (!merchant.match) { blockerDecision = 'rejected'; reasons = ['merchant order details do not match the approved order', ...merchant.differences]; }
    else if (unsure.length) { blockerDecision = 'in_review'; reasons = unsure; }
    else { blockerDecision = 'accepted'; reasons = []; }
  } else {
    blockerDecision = 'in_review';
    reasons = [`can't verify with the store: ${merchant.reason}`, ...verdict.reasons];
  }
  return { decision: mode === 'blocker' ? blockerDecision : 'accepted', blockerDecision, reasons };
}
