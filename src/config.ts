import fs from 'node:fs';
import yaml from 'js-yaml';

export type LimitBehavior = 'degrade' | 'request-approval' | 'deny';

export interface RampBudgetConfig {
  rampBudgetId: string;
  monthlyLimit: number;
  maxTaskAllowance: number;
  allowedModels: string[];
  fallbackModel: string;
  onLimit: LimitBehavior;
  taskTtlSeconds: number;
  costCenter: string;
}

export interface ScripConfig {
  team: string;
  rampEntityId: string;
  budgets: Record<string, RampBudgetConfig>;
}

interface RawBudget {
  ramp_budget_id: string;
  monthly_limit: number;
  max_task_allowance: number;
  allowed_models: string[];
  fallback_model: string;
  on_limit: LimitBehavior;
  task_ttl_seconds: number;
  cost_center: string;
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
    budgets[name] = {
      rampBudgetId: budget.ramp_budget_id,
      monthlyLimit: budget.monthly_limit,
      maxTaskAllowance: budget.max_task_allowance,
      allowedModels: budget.allowed_models,
      fallbackModel: budget.fallback_model,
      onLimit: budget.on_limit,
      taskTtlSeconds: budget.task_ttl_seconds,
      costCenter: budget.cost_center,
    };
  }

  return { team: raw.team, rampEntityId: raw.ramp_entity_id, budgets };
}
