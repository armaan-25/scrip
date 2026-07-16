import { describe, expect, it } from 'vitest';
import { computeCost, getModelPrice } from '../src/pricing.js';

describe('pricing', () => {
  it('returns known prices for the demo models', () => {
    expect(getModelPrice('claude-sonnet-5')).toEqual({ inputPrice: 3.0, outputPrice: 15.0 });
    expect(getModelPrice('claude-haiku-4-5-20251001')).toEqual({ inputPrice: 1.0, outputPrice: 5.0 });
  });

  it('throws for an unknown model', () => {
    expect(() => getModelPrice('not-a-real-model')).toThrow();
  });

  it('computes cost from token counts at $/1M-token rates', () => {
    // 1000 input tokens + 500 output tokens on claude-sonnet-5 ($3/$15 per 1M)
    const cost = computeCost('claude-sonnet-5', 1000, 500);
    expect(cost).toBeCloseTo((1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0);
  });
});
