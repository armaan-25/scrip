import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads Ramp budgets and task credential policy', () => {
    const config = loadConfig('scrip.yaml');
    expect(config.team).toBe('agent-platform');
    expect(config.rampEntityId).toBe('ramp-entity-demo');
    expect(config.budgets.research).toEqual({
      rampBudgetId: 'ramp-budget-research',
      monthlyLimit: 100,
      maxTaskAllowance: 10,
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      fallbackModel: 'claude-haiku-4-5-20251001',
      onLimit: 'deny',
      taskTtlSeconds: 900,
      costCenter: 'AI compute',
    });
  });

  it('throws for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });
});
