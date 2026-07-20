import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads Ramp budgets and task credential policy', () => {
    const config = loadConfig('scrip.yaml');
    expect(config.team).toBe('agent-platform');
    expect(config.rampEntityId).toBe('ramp-entity-demo');
    expect(config.budgets.research).toEqual({
      rampBudgetId: 'ramp-budget-research',
      rampFundId: 'cd1c33eb-d742-4d7e-850f-972eb3c3c53f',
      monthlyLimit: 100,
      maxTaskAllowance: 10,
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      fallbackModel: 'claude-haiku-4-5-20251001',
      onLimit: 'deny',
      taskTtlSeconds: 900,
      costCenter: 'AI compute',
      maxDelegationDepth: 3,
      minRequestInputTokens: 500,
      minRequestOutputTokens: 200,
    });
  });

  it('leaves rampFundId undefined when not configured', () => {
    const config = loadConfig('scrip.yaml');
    expect(config.budgets.support.rampFundId).toBeUndefined();
  });

  it('throws for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });
});
