import { describe, expect, it } from 'vitest';
import { BudgetRouter } from '../src/router.js';

describe('BudgetRouter', () => {
  const router = new BudgetRouter();
  const allowedModels = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const fallbackModel = 'claude-haiku-4-5-20251001';

  it('picks the premium model when remaining budget comfortably covers the scaled estimate', () => {
    // taskEstimate priced at the fallback (haiku, $5/1M out); sonnet is 3x haiku's output price
    const model = router.route({
      remainingBudget: 1.0,
      taskEstimate: 0.1,
      allowedModels,
      fallbackModel,
    });
    expect(model).toBe('claude-sonnet-5');
  });

  it('degrades to the fallback model when the scaled estimate would exceed remaining budget', () => {
    const model = router.route({
      remainingBudget: 0.2,
      taskEstimate: 0.1,
      allowedModels,
      fallbackModel,
    });
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('always returns the fallback model when it is the only allowed model', () => {
    const model = router.route({
      remainingBudget: 100,
      taskEstimate: 0.01,
      allowedModels: [fallbackModel],
      fallbackModel,
    });
    expect(model).toBe(fallbackModel);
  });
});
