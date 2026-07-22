import { describe, expect, it } from 'vitest';
import { deriveCapabilityPolicy, deriveResourceLimits, loadConfig } from '../src/config.js';

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

  it('loads controllerModel for the request-approval budget', () => {
    const config = loadConfig('scrip.yaml');
    expect(config.budgets.escalation.controllerModel).toBe('claude-sonnet-5');
    expect(config.budgets.research.controllerModel).toBeUndefined();
  });

  it('throws for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });

  it('derives ResourceLimits from an existing budget with no new config fields', () => {
    const config = loadConfig('scrip.yaml');
    expect(deriveResourceLimits(config.budgets.research)).toEqual({ maxUsd: 10, maxDelegationDepth: 3 });
  });

  it('derives CapabilityPolicy, including allowedProviders from model pricing', () => {
    const config = loadConfig('scrip.yaml');
    const policy = deriveCapabilityPolicy(config.budgets.research);
    expect(policy.allowedModels).toEqual(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(policy.allowedProviders).toEqual(['anthropic']);
    expect(policy.requiresApprovalAboveUsd).toBeUndefined();
  });

  it('derives requiresApprovalAboveUsd only for a request-approval budget', () => {
    const config = loadConfig('scrip.yaml');
    const policy = deriveCapabilityPolicy(config.budgets.escalation);
    expect(policy.requiresApprovalAboveUsd).toBe(config.budgets.escalation.maxTaskAllowance);
  });

  it('derives allowedProviders across both providers for the cross-provider demo budget', () => {
    const config = loadConfig('scrip.yaml');
    const policy = deriveCapabilityPolicy(config.budgets.cross_provider_demo);
    expect(policy.allowedProviders?.sort()).toEqual(['anthropic', 'openai']);
  });
});
