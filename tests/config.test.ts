import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses the demo spendspec.yaml into typed config', () => {
    const config = loadConfig('spendspec.yaml');

    expect(config.team).toBe('hackathon-demo');
    expect(config.projects['research-agent'].monthlyBudget).toBe(2);
    expect(config.projects['research-agent'].features['default']).toEqual({
      monthlyBudget: 2,
      maxPerRequest: 2.0,
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      fallbackModel: 'claude-haiku-4-5-20251001',
      onLimit: 'degrade',
    });
  });

  it('throws a clear error for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });
});
