import { describe, expect, it } from 'vitest';
import { judgeMusts, parseJudgeReply } from '../src/purchase/judge.js';
import { decidePurchase, pageSeen, parseItem, type PurchaseItem } from '../src/purchase/purchase.js';

const task = { words: 'Buy AA batteries', budgetCents: 2000, musts: ['Duracell or Amazon Basics', '12 batteries'] };
const item: PurchaseItem = { merchant: 'Amazon', item: 'Amazon Basics AA 12-pack', details: '12 count, alkaline', quantity: 1, totalCents: 1149, url: 'https://www.amazon.com/dp/B00MNV8E0C?th=1' };
const yes = [{ must: 'Duracell or Amazon Basics', verdict: 'yes' as const, reason: 'Amazon Basics' }, { must: '12 batteries', verdict: 'yes' as const, reason: '12 count' }];
const readIt = 'Amazon Basics AA 12 pack $11.49 amazon.com/dp/B00MNV8E0C';

describe('decidePurchase', () => {
  it('accepts when in budget, the price and page were seen, and every must-have is met', () => {
    expect(decidePurchase(task, item, readIt, [], yes, 'blocker')).toMatchObject({ decision: 'accepted', priceSeen: true, pageSeen: true, reasons: [] });
  });

  it('rejects over budget or a failed must-have; reviews an unseen price, an unseen page, or an unsure checker', () => {
    expect(decidePurchase(task, { ...item, totalCents: 2500 }, '$25.00 amazon.com/dp/B00MNV8E0C', [], yes, 'blocker').reasons).toEqual(['$25.00 is over the $20.00 budget']);
    expect(decidePurchase(task, item, readIt, [], [yes[0], { must: '12 batteries', verdict: 'no', reason: 'it is an 8-pack' }], 'blocker').decision).toBe('rejected');
    expect(decidePurchase(task, item, 'Amazon Basics AA from $9.99 amazon.com/dp/B00MNV8E0C', [], yes, 'blocker'))
      .toMatchObject({ decision: 'in_review', reasons: ['$11.49 never appeared in anything the agent read'] });
    expect(decidePurchase(task, item, '$11.49', [], yes, 'blocker').reasons).toEqual(['the agent never opened or saw the page it cites']);
    expect(decidePurchase(task, item, readIt, [], [yes[0], { must: '12 batteries', verdict: 'unsure', reason: 'count not stated' }], 'blocker').decision).toBe('in_review');
  });

  it('observer mode accepts but keeps what blocker would have done', () => {
    expect(decidePurchase(task, { ...item, totalCents: 2500 }, '', [], yes, 'observer')).toMatchObject({ decision: 'accepted', blockerDecision: 'rejected' });
  });

  it('treats a page as seen if it was opened (ignoring query strings) or appeared in results', () => {
    expect(pageSeen('https://www.amazon.com/dp/X?th=1', ['https://amazon.com/dp/X'], '')).toBe(true);
    expect(pageSeen('https://shop.example/p/1', [], 'see https://shop.example/p/1 for details')).toBe(true);
    expect(pageSeen('https://shop.example/p/1', ['https://shop.example/p/2'], '')).toBe(false);
  });

  it('parses checkout arguments at the boundary', () => {
    expect(parseItem({ merchant: 'Amazon', item: 'x', totalUsd: 11.49, url: 'https://a.com' })).toMatchObject({ totalCents: 1149, quantity: 1 });
    expect(parseItem({ merchant: 'Amazon', item: 'x', totalUsd: 0, url: 'https://a.com' })).toMatch(/totalUsd/);
    expect(parseItem({ merchant: 'Amazon', item: 'x', totalUsd: 5, url: 'ftp://a' })).toMatch(/url/);
  });
});

describe('must-have checker', () => {
  it('reads one answer per must-have; anything missing or malformed is unsure', () => {
    expect(parseJudgeReply('Sure: [{"must":"a","verdict":"yes","reason":"ok"},{"verdict":"maybe"}]', ['a', 'b'])).toEqual([
      { must: 'a', verdict: 'yes', reason: 'ok' },
      { must: 'b', verdict: 'unsure', reason: 'the checker gave no usable answer' },
    ]);
    expect(parseJudgeReply('not json', ['a']).map(c => c.verdict)).toEqual(['unsure']);
  });

  it('sends the item and must-haves only, and falls back to unsure when the checker fails', async () => {
    let seen = '';
    const ok = await judgeMusts(item, task.musts, async p => { seen = p; return JSON.stringify(yes); });
    expect(ok.checks.map(c => c.verdict)).toEqual(['yes', 'yes']);
    expect(seen).toContain('Amazon Basics AA 12-pack');
    expect(seen).toContain('1. Duracell or Amazon Basics');
    const failed = await judgeMusts(item, task.musts, async () => { throw new Error('timeout'); });
    expect(failed).toMatchObject({ error: 'timeout', checks: [{ verdict: 'unsure' }, { verdict: 'unsure' }] });
    expect((await judgeMusts(item, [], async () => 'x')).checks).toEqual([]);
  });
});
