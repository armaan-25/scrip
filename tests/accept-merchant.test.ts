import { describe, expect, it } from 'vitest';
import { canonicalProduct, compareOrders, merchantOrder } from '../src/merchant/accept-merchant.js';

describe('stand-in Accept merchant', () => {
  it("prices from the store's Shopify product data, honoring ?variant=", async () => {
    const json = JSON.stringify({ product: { title: 'Tree Runner', variants: [{ id: 8, title: '8', price: '100.00' }, { id: 9, title: '9', price: '110.00' }] } });
    const reply = await merchantOrder('https://www.allbirds.com/products/mens-tree-runners?variant=9', 2, async u => (u.endsWith('.json') ? { status: 200, text: json } : { status: 404, text: '' }));
    expect(reply).toEqual({ status: 'priced', order: { store: 'allbirds.com', product: '/products/mens-tree-runners', title: 'Tree Runner', variant: '9', unitCents: 11000, optionMatched: false, quantity: 2, totalCents: 22000, source: 'shopify' } });
  });

  it('prices from schema.org Product markup, and says so plainly when a store publishes nothing', async () => {
    const page = '<script type="application/ld+json">{"@type":"Product","name":"DDIA","offers":{"price":"59.99"}}</script>';
    expect(await merchantOrder('https://porchlightbooks.com/p/ddia', 1, async () => ({ status: 200, text: page }))).toMatchObject({ status: 'priced', order: { totalCents: 5999, source: 'schema.org' } });
    expect(await merchantOrder('https://www.amazon.com/dp/X', 1, async () => ({ status: 200, text: '<html></html>' }))).toEqual({ status: 'unavailable', reason: 'amazon.com has no public cart or order data to read' });
    expect((await merchantOrder('https://www.bestbuy.com/x', 1, async () => ({ status: 403, text: '' }))).status).toBe('unavailable');
  });

  it('fingerprints the same canonical fields on both sides and names every difference', () => {
    const where = canonicalProduct('https://www.shop.example/products/aa-12/?ref=x');
    expect(where).toEqual({ store: 'shop.example', product: '/products/aa-12' });
    const approved = { store: 'shop.example', product: '/products/aa-12', quantity: 1, totalCents: 1149 };
    expect(compareOrders(approved, { ...approved }).match).toBe(true);
    const off = compareOrders(approved, { ...approved, quantity: 2, totalCents: 2298 });
    expect(off.match).toBe(false);
    expect(off.approvedFingerprint).not.toBe(off.merchantFingerprint);
    expect(off.differences).toEqual(['quantity: approved 1, merchant charging for 2', 'total: approved $11.49, merchant charging $22.98']);
  });

  it("charges for the option the agent named, and a different option breaks the fingerprint", async () => {
    const json = JSON.stringify({ product: { title: 'Tree Runner', variants: [{ id: 8, title: '8', price: '100.00' }, { id: 9, title: '9', price: '100.00' }] } });
    const fetchPage = async (u: string) => (u.endsWith('.json') ? { status: 200, text: json } : { status: 404, text: '' });
    for (const named of ['9', 'Jet Black (Black Sole) / 9', "Men's size 9", 'size 9, Jet Black']) {
      const nine = await merchantOrder('https://www.allbirds.com/products/tree', 1, fetchPage, named);
      expect(nine.status === 'priced' && [nine.order.variant, nine.order.optionMatched]).toEqual(['9', true]);
    }
    const approved = { store: 'allbirds.com', product: '/products/tree', quantity: 1, totalCents: 10000, variant: '9' };
    const first = await merchantOrder('https://www.allbirds.com/products/tree', 1, fetchPage);
    if (first.status !== 'priced') throw new Error('expected a priced order');
    expect(compareOrders(approved, first.order)).toMatchObject({ match: false, differences: ['option: approved 9, merchant charging for 8'] });
  });

  it('treats the same option written differently as the same option, and a different one as different', async () => {
    const json = JSON.stringify({ product: { title: 'Dark Roast', variants: [{ id: 1, title: 'Whole Bean / 1 lb', price: '19.99' }, { id: 2, title: 'Ground / 1 lb', price: '19.99' }, { id: 3, title: 'Ground / 5 lb', price: '79.99' }] } });
    const fetchPage = async (u: string) => (u.endsWith('.json') ? { status: 200, text: json } : { status: 404, text: '' });
    for (const [named, store] of [['Ground, 1 lb (16 oz)', 'Ground / 1 lb'], ['ground / 5 lb', 'Ground / 5 lb'], ['Whole Bean, 1 lb', 'Whole Bean / 1 lb']] as const) {
      const r = await merchantOrder('https://shop.example/products/dark', 1, fetchPage, named);
      expect(r.status === 'priced' && [r.order.variant, r.order.optionMatched]).toEqual([store, true]);
    }
    const r = await merchantOrder('https://shop.example/products/dark', 1, fetchPage, 'Ground, 2 lb');
    expect(r.status === 'priced' && r.order.optionMatched).toBe(false);
  });
});

describe("the store's own cart", () => {
  it('builds a cart with the exact variant and quantity, and uses the cart total, not the catalog price', async () => {
    const json = JSON.stringify({ product: { title: 'Dark Roast', variants: [{ id: 11, title: 'Ground / 1 lb', price: '19.99' }] } });
    const calls: string[] = [];
    const http = async (req: { method: 'GET' | 'POST'; url: string; body?: string; cookie?: string }) => {
      calls.push([req.method, req.url, req.body, req.cookie].filter(Boolean).join(' '));
      if (req.method === 'POST') return { status: 200, text: '{}', setCookies: ['cart=abc; path=/; HttpOnly', 'other=1'] };
      if (!req.cookie) return { status: 200, text: '{"items":[]}', setCookies: ['session=s1; path=/'] };
      return { status: 200, text: JSON.stringify({ token: 'tokenvalue123456', total_price: 3598, items: [{ product_title: 'Dark Roast Coffee', variant_title: 'Ground / 1 lb', quantity: 2, final_line_price: 3598, sku: '50251G' }] }), setCookies: [] };
    };
    const reply = await merchantOrder('https://www.deathwishcoffee.com/products/death-wish-coffee', 2, async () => ({ status: 200, text: json }), 'Ground, 1 lb', http);
    expect(calls).toEqual([
      'GET https://www.deathwishcoffee.com/cart.js',
      'POST https://www.deathwishcoffee.com/cart/add.js {"items":[{"id":11,"quantity":2}]} session=s1',
      'GET https://www.deathwishcoffee.com/cart.js session=s1; cart=abc; other=1',
    ]);
    expect(reply).toMatchObject({ status: 'priced', order: { source: 'cart', variant: 'Ground / 1 lb', quantity: 2, totalCents: 3598, sku: '50251G', cartToken: 'tokenvalue12' } });
  });

  it("falls back to the catalog, labeled as such, when the store's cart can't be built", async () => {
    const json = JSON.stringify({ product: { title: 'Dark Roast', variants: [{ id: 11, title: 'Ground / 1 lb', price: '19.99' }] } });
    const reply = await merchantOrder('https://shop.example/products/dark', 1, async () => ({ status: 200, text: json }), undefined, async () => ({ status: 403, text: '', setCookies: [] }));
    expect(reply).toMatchObject({ status: 'priced', order: { source: 'shopify', totalCents: 1999 } });
  });
});

describe("the store's own cart, when the store redirects the cart read", () => {
  it("uses the store's reply to the add (its computed line) if the cart read comes back empty", async () => {
    const json = JSON.stringify({ product: { title: 'Ridge Wallet', variants: [{ id: 5, title: 'Default Title', price: '175.00' }] } });
    const http = async (req: { method: 'GET' | 'POST'; url: string; body?: string; cookie?: string }) => req.method === 'POST'
      ? { status: 200, text: JSON.stringify({ items: [{ product_title: 'Ridge Wallet + Power Bank', variant_title: null, quantity: 1, final_line_price: 17500, sku: 'RW-PB' }] }), setCookies: ['cart=r1'] }
      : { status: 200, text: '{"items":[],"total_price":0}', setCookies: [] };
    const reply = await merchantOrder('https://www.ridgewallet.com/products/wallet-power-bank', 1, async () => ({ status: 200, text: json }), undefined, http);
    expect(reply).toMatchObject({ status: 'priced', order: { source: 'cart', totalCents: 17500, sku: 'RW-PB', quantity: 1 } });
  });
});
