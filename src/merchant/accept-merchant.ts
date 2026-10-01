/**
 * Stand-in for a Natural Accept merchant sending order details at payment.
 *
 * Natural does not yet pass merchant order details to the card side; this
 * module plays that merchant. It is separate from Scrip and never uses the
 * agent's description: it reads the store's OWN structured product data
 * (Shopify product JSON, or schema.org Product markup on the page) and builds
 * the order it would charge for. Stores that publish no such data (Amazon,
 * Best Buy, ...) get "unavailable": no merchant order details exist, which is
 * exactly the gap the Accept feature would close.
 *
 * Both sides are fingerprinted over the same canonical fields, so A (the
 * order the agent got approved) and B (the order the merchant charges) can be
 * compared exactly, and every differing field can be named.
 */
import type { FetchPage } from '../agent/source-check.js';
import { orderFingerprint } from '../trace/fingerprint.js';

/** The fields both sides agree on. Product titles are shown, not compared: stores and agents word them differently. */
export interface CanonicalOrder { store: string; product: string; quantity: number; totalCents: number; /** Size, color, or other option; compared when the store has options. */ variant?: string }
export interface MerchantOrder extends CanonicalOrder {
  title: string; unitCents: number; source: 'shopify' | 'schema.org';
  /** True when the store found the option the agent named (so the approved order can use the store's own name for it). */
  optionMatched?: boolean;
}
export type MerchantReply = { status: 'priced'; order: MerchantOrder } | { status: 'unavailable'; reason: string };
export interface OrderComparison { approvedFingerprint: string; merchantFingerprint: string; match: boolean; differences: string[] }

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Store = hostname without www; product = path without trailing slash (query strings and variants excluded). */
export function canonicalProduct(url: string): { store: string; product: string } | null {
  try {
    const u = new URL(url);
    return { store: u.hostname.replace(/^www\./, '').toLowerCase(), product: u.pathname.replace(/\/$/, '').toLowerCase() };
  } catch { return null; }
}

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

export function fingerprintOrder(o: CanonicalOrder): string {
  return orderFingerprint({ store: o.store, product: o.product, quantity: o.quantity, totalCents: o.totalCents, variant: norm(o.variant) });
}

export function compareOrders(approved: CanonicalOrder, merchant: CanonicalOrder): OrderComparison {
  const differences = [
    ...(approved.store !== merchant.store ? [`store: approved ${approved.store}, merchant is ${merchant.store}`] : []),
    ...(approved.product !== merchant.product ? [`product: approved ${approved.product}, merchant charging for ${merchant.product}`] : []),
    ...(norm(approved.variant) !== norm(merchant.variant) ? [`option: approved ${approved.variant ?? 'none'}, merchant charging for ${merchant.variant ?? 'none'}`] : []),
    ...(approved.quantity !== merchant.quantity ? [`quantity: approved ${approved.quantity}, merchant charging for ${merchant.quantity}`] : []),
    ...(approved.totalCents !== merchant.totalCents ? [`total: approved ${usd(approved.totalCents)}, merchant charging ${usd(merchant.totalCents)}`] : []),
  ];
  const approvedFingerprint = fingerprintOrder(approved);
  const merchantFingerprint = fingerprintOrder(merchant);
  return { approvedFingerprint, merchantFingerprint, match: approvedFingerprint === merchantFingerprint, differences };
}

const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/**
 * Shopify's public product JSON. The merchant charges for the variant in the
 * link (?variant=), else the option the agent named (matched to the store's
 * own option names, e.g. "9" or "9 / Black"), else its first available one.
 */
function fromShopify(json: unknown, variantId: string | null, wanted: string | undefined): { title: string; variant?: string; unitCents: number; optionMatched: boolean } | null {
  const product = (json as { product?: { title?: string; variants?: { id?: number; title?: string; price?: string; available?: boolean }[] } }).product;
  const variants = product?.variants ?? [];
  // Every part of the store's option name must appear in what the agent named: store "9" matches "Jet Black / 9" and "size 9".
  const parts = (v: string | undefined): string[] => norm(v).split(/\s*[/,]\s*/).map(p => p.replace(/\b(size|us|men'?s|women'?s)\b/g, '').trim()).filter(Boolean);
  const wantedParts = parts(wanted);
  const byName = wantedParts.length ? variants.find(v => { const vp = parts(v.title); return vp.length > 0 && vp.every(p => wantedParts.includes(p)); }) : undefined;
  const chosen = (variantId && variants.find(v => String(v.id) === variantId)) || byName || variants.find(v => v.available !== false) || variants[0];
  const unit = cents(chosen?.price);
  if (!product?.title || !chosen || unit === null) return null;
  return { title: product.title, variant: chosen.title && chosen.title !== 'Default Title' ? chosen.title : undefined, unitCents: unit, optionMatched: Boolean(byName && chosen === byName) };
}

/** schema.org Product markup (JSON-LD) on the page: name and the first offer's price. */
function fromSchemaOrg(html: string): { title: string; unitCents: number } | null {
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(block[1] ?? ''); } catch { continue; }
    const nodes: unknown[] = Array.isArray(data) ? data : [data, ...(((data as { '@graph'?: unknown[] })['@graph']) ?? [])];
    for (const node of nodes) {
      const n = node as { '@type'?: unknown; name?: string; offers?: unknown };
      const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
      if (!types.includes('Product') || !n.name) continue;
      const offer = (Array.isArray(n.offers) ? n.offers[0] : n.offers) as { price?: unknown; lowPrice?: unknown } | undefined;
      const unit = cents(offer?.price ?? offer?.lowPrice);
      if (unit !== null) return { title: n.name, unitCents: unit };
    }
  }
  return null;
}

/** The merchant prices the order from its own data, or says it can't. */
export async function merchantOrder(url: string, quantity: number, fetchPage: FetchPage, wantedOption?: string): Promise<MerchantReply> {
  const where = canonicalProduct(url);
  if (!where) return { status: 'unavailable', reason: 'the product address is not a valid URL' };
  const u = new URL(url);
  try {
    if (u.pathname.includes('/products/')) {
      const json = await fetchPage(`${u.origin}${u.pathname.replace(/\/$/, '')}.json`);
      if (json.status < 400) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(json.text); } catch { parsed = null; }
        const found = parsed ? fromShopify(parsed, u.searchParams.get('variant'), wantedOption) : null;
        if (found) return { status: 'priced', order: { ...where, ...found, quantity, totalCents: found.unitCents * quantity, source: 'shopify' } };
      }
    }
    const page = await fetchPage(url);
    if (page.status >= 400) return { status: 'unavailable', reason: `${where.store} refused the request (HTTP ${page.status}), so it sent no order details` };
    const found = fromSchemaOrg(page.text);
    if (found) return { status: 'priced', order: { ...where, ...found, quantity, totalCents: found.unitCents * quantity, source: 'schema.org' } };
    return { status: 'unavailable', reason: `${where.store} publishes no machine-readable order data, so it sent no order details` };
  } catch (error) {
    return { status: 'unavailable', reason: `${where.store} could not be reached (${(error as Error).message})` };
  }
}
