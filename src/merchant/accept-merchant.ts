/**
 * The merchant's side of the order: what the store itself says is being bought.
 *
 * For Shopify stores Scrip builds a REAL cart at the store (the exact variant
 * and quantity the agent chose, via the store's public cart API) and reads
 * back the store's own computed cart: items, option, quantity, SKU, total.
 * Nothing is bought; the cart is abandoned. Other stores fall back to their
 * published catalog data (labeled as such), or to "unavailable".
 *
 * Originally a stand-in for a Natural Accept merchant sending order details at payment.
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
  title: string; unitCents: number;
  /** cart: the store's own cart, built at the store. shopify / schema.org: published catalog price, not a cart. */
  source: 'cart' | 'shopify' | 'schema.org';
  sku?: string;
  cartToken?: string;
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
function fromShopify(json: unknown, variantId: string | null, wanted: string | undefined): { title: string; variant?: string; variantId: number; unitCents: number; optionMatched: boolean } | null {
  const product = (json as { product?: { title?: string; variants?: { id?: number; title?: string; price?: string; available?: boolean }[] } }).product;
  const variants = product?.variants ?? [];
  // Every part of the store's option name must appear in what the agent named: store "9" matches "Jet Black / 9" and
  // "size 9"; store "Ground / 1 lb" matches "Ground, 1 lb (16 oz)". Parenthetical asides and words like "size" are ignored.
  const parts = (v: string | undefined): string[] => norm(v).replace(/\([^)]*\)/g, ' ').split(/\s*[/,]\s*/)
    .map(p => p.replace(/\b(size|us|men'?s|women'?s)\b/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const wantedText = ` ${parts(wanted).join(' | ')} `;
  const contains = (part: string): boolean => new RegExp(`(^|[\\s|])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s|]|$)`).test(wantedText);
  const byName = wanted ? variants.find(v => { const vp = parts(v.title); return vp.length > 0 && vp.every(contains); }) : undefined;
  const chosen = (variantId && variants.find(v => String(v.id) === variantId)) || byName || variants.find(v => v.available !== false) || variants[0];
  const unit = cents(chosen?.price);
  if (!product?.title || !chosen || unit === null || typeof chosen.id !== 'number') return null;
  return { title: product.title, variant: chosen.title && chosen.title !== 'Default Title' ? chosen.title : undefined, variantId: chosen.id, unitCents: unit, optionMatched: Boolean(byName && chosen === byName) };
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

/** Minimal HTTP with cookies, for the store's cart session. Injectable so tests never touch real stores. */
export type CartHttp = (req: { method: 'GET' | 'POST'; url: string; body?: string; cookie?: string }) => Promise<{ status: number; text: string; setCookies: string[] }>;

export const liveCartHttp: CartHttp = async ({ method, url, body, cookie }) => {
  const res = await fetch(url, {
    method, body, signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Scrip cart check)', ...(cookie ? { cookie } : {}) },
  });
  return { status: res.status, text: await res.text(), setCookies: res.headers.getSetCookie() };
};

interface ShopifyCart { token?: string; total_price?: number; currency?: string; items?: { product_title?: string; variant_title?: string | null; quantity?: number; final_line_price?: number; sku?: string; url?: string }[] }

/** Build a fresh cart at the store with exactly this variant and quantity, and read back the store's own cart. */
export async function buildStoreCart(origin: string, variantId: number, quantity: number, http: CartHttp): Promise<ShopifyCart | null> {
  // Keep one cookie jar across all three requests: some stores only link the add and the read when the
  // session is opened first, otherwise the read lands on a fresh, empty cart.
  const jar = new Map<string, string>();
  const keep = (setCookies: string[]) => { for (const c of setCookies) { const [pair] = c.split(';'); const i = pair?.indexOf('=') ?? -1; if (pair && i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ') || undefined;
  const open = await http({ method: 'GET', url: `${origin}/cart.js` });
  keep(open.setCookies);
  const add = await http({ method: 'POST', url: `${origin}/cart/add.js`, body: JSON.stringify({ items: [{ id: variantId, quantity }] }), cookie: cookie() });
  if (add.status >= 400) return null;
  keep(add.setCookies);
  // The store's reply to the add is already its own computed line for this item. Prefer the full cart when the
  // read returns exactly our item; some stores redirect /cart.js somewhere the session doesn't follow.
  let added: ShopifyCart['items'] = [];
  try { const body = JSON.parse(add.text) as { items?: ShopifyCart['items'] } & NonNullable<ShopifyCart['items']>[number]; added = body.items ?? (body.product_title ? [body] : []); } catch { added = []; }
  const read = await http({ method: 'GET', url: `${origin}/cart.js`, cookie: cookie() });
  let cart: ShopifyCart | null = null;
  try { cart = read.status < 400 ? (JSON.parse(read.text) as ShopifyCart) : null; } catch { cart = null; }
  if (cart?.items?.length === 1 && (cart.total_price ?? 0) > 0) return cart;
  const line = added?.length === 1 ? added[0] : undefined;
  if (line && typeof line.final_line_price === 'number' && line.final_line_price > 0) return { token: cart?.token, total_price: line.final_line_price, items: [line] };
  return null;
}

/** The merchant's side of the order: the store's own cart where possible, else its catalog, else unavailable. */
export async function merchantOrder(url: string, quantity: number, fetchPage: FetchPage, wantedOption?: string, http?: CartHttp): Promise<MerchantReply> {
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
        if (found && http) {
          const cart = await buildStoreCart(u.origin, found.variantId, quantity, http);
          const line = cart?.items?.length === 1 ? cart.items[0] : undefined;
          if (cart && line && typeof cart.total_price === 'number' && typeof line.quantity === 'number') {
            return { status: 'priced', order: {
              ...where, title: line.product_title ?? found.title, variant: line.variant_title ?? undefined, optionMatched: found.optionMatched,
              unitCents: Math.round((line.final_line_price ?? cart.total_price) / line.quantity), quantity: line.quantity, totalCents: cart.total_price,
              source: 'cart', ...(line.sku ? { sku: line.sku } : {}), ...(cart.token ? { cartToken: cart.token.slice(0, 12) } : {}),
            } };
          }
        }
        if (found) { const { variantId: _id, ...rest } = found; return { status: 'priced', order: { ...where, ...rest, quantity, totalCents: found.unitCents * quantity, source: 'shopify' } }; }
      }
    }
    const page = await fetchPage(url);
    if (page.status >= 400) return { status: 'unavailable', reason: `${where.store} refused the request (HTTP ${page.status}), so there is no cart or order data to read` };
    const found = fromSchemaOrg(page.text);
    if (found) return { status: 'priced', order: { ...where, ...found, quantity, totalCents: found.unitCents * quantity, source: 'schema.org' } };
    return { status: 'unavailable', reason: `${where.store} has no public cart or order data to read` };
  } catch (error) {
    return { status: 'unavailable', reason: `${where.store} could not be reached (${(error as Error).message})` };
  }
}
