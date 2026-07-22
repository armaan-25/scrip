import fs from 'node:fs';
import yaml from 'js-yaml';
import { getModelPrice } from './pricing.js';

export type LimitBehavior = 'degrade' | 'request-approval' | 'deny';

export interface RampBudgetConfig {
  rampBudgetId: string;
  rampFundId?: string;
  monthlyLimit: number;
  maxTaskAllowance: number;
  allowedModels: string[];
  fallbackModel: string;
  onLimit: LimitBehavior;
  taskTtlSeconds: number;
  costCenter: string;
  maxDelegationDepth: number;
  minRequestInputTokens: number;
  minRequestOutputTokens: number;
  controllerModel?: string;
}

export interface ScripConfig {
  team: string;
  rampEntityId: string;
  budgets: Record<string, RampBudgetConfig>;
}

/**
 * The pivot's resource envelope. `scrip.yaml` has no independent fields for
 * these yet (no max_tokens/max_requests/max_concurrency/max_subagents/
 * max_wall_clock_seconds key exists in the schema below) - deriveResourceLimits()
 * is a *view* over the RampBudgetConfig fields that already carry this
 * meaning, not a new stored config, so it's always correct and never
 * silently stale. Fields with no current equivalent are honestly undefined
 * rather than a fabricated default.
 */
export interface ResourceLimits {
  maxUsd: number;
  maxTokens?: number;
  maxRequests?: number;
  maxConcurrency?: number;
  maxSubagents?: number;
  maxDelegationDepth: number;
  maxWallClockSeconds?: number;
}

/**
 * The pivot's capability envelope, same derivation approach as
 * ResourceLimits: a view over existing RampBudgetConfig fields, not new
 * config. `allowedProviders` is derived from `allowedModels` via
 * getModelPrice().provider (see deriveCapabilityPolicy in this file);
 * `allowedTools`/`allowedActionTypes` have no config source yet - Scrip has
 * no per-budget tool or action-type allowlist today - and stay undefined
 * rather than claiming a policy that isn't actually enforced anywhere.
 */
export interface CapabilityPolicy {
  allowedModels: string[];
  allowedProviders?: string[];
  allowedTools?: string[];
  allowedActionTypes?: string[];
  requiresApprovalAboveUsd?: number;
}

export function deriveResourceLimits(budget: RampBudgetConfig): ResourceLimits {
  return {
    maxUsd: budget.maxTaskAllowance,
    maxDelegationDepth: budget.maxDelegationDepth,
  };
}

export function deriveCapabilityPolicy(budget: RampBudgetConfig): CapabilityPolicy {
  const allowedProviders = [...new Set(budget.allowedModels.map((model) => getModelPrice(model).provider))];
  return {
    allowedModels: budget.allowedModels,
    allowedProviders,
    requiresApprovalAboveUsd: budget.onLimit === 'request-approval' ? budget.maxTaskAllowance : undefined,
  };
}

interface RawBudget {
  ramp_budget_id: string;
  ramp_fund_id?: string;
  monthly_limit: number;
  max_task_allowance: number;
  allowed_models: string[];
  fallback_model: string;
  on_limit: LimitBehavior;
  task_ttl_seconds: number;
  cost_center: string;
  max_delegation_depth: number;
  min_request_input_tokens: number;
  min_request_output_tokens: number;
  controller_model?: string;
}

interface RawConfig {
  team: string;
  ramp_entity_id: string;
  budgets: Record<string, RawBudget>;
}

export function loadConfig(filePath: string): ScripConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as RawConfig;
  if (!raw?.team || !raw.ramp_entity_id || !raw.budgets) {
    throw new Error('Config must define team, ramp_entity_id, and budgets');
  }

  const budgets: Record<string, RampBudgetConfig> = {};
  for (const [name, budget] of Object.entries(raw.budgets)) {
    if (budget.monthly_limit <= 0 || budget.max_task_allowance <= 0) {
      throw new Error(`Budget "${name}" limits must be positive`);
    }
    if (budget.max_task_allowance > budget.monthly_limit) {
      throw new Error(`Budget "${name}" max_task_allowance cannot exceed monthly_limit`);
    }
    if (!budget.allowed_models.includes(budget.fallback_model)) {
      throw new Error(`Budget "${name}" fallback_model must be in allowed_models`);
    }
    if (budget.max_delegation_depth <= 0) {
      throw new Error(`Budget "${name}" max_delegation_depth must be positive`);
    }
    budgets[name] = {
      rampBudgetId: budget.ramp_budget_id,
      rampFundId: budget.ramp_fund_id,
      monthlyLimit: budget.monthly_limit,
      maxTaskAllowance: budget.max_task_allowance,
      allowedModels: budget.allowed_models,
      fallbackModel: budget.fallback_model,
      onLimit: budget.on_limit,
      taskTtlSeconds: budget.task_ttl_seconds,
      costCenter: budget.cost_center,
      maxDelegationDepth: budget.max_delegation_depth,
      minRequestInputTokens: budget.min_request_input_tokens,
      minRequestOutputTokens: budget.min_request_output_tokens,
      controllerModel: budget.controller_model,
    };
  }

  return { team: raw.team, rampEntityId: raw.ramp_entity_id, budgets };
}
