import fs from 'node:fs';
import yaml from 'js-yaml';

export interface BudgetConfig {
  budgetId: string;
  monthlyLimit: number;
  maxTaskAllowance: number;
  taskTtlSeconds: number;
  costCenter: string;
  maxDelegationDepth: number;
}

export interface ScripConfig {
  team: string;
  entityId: string;
  budgets: Record<string, BudgetConfig>;
}

interface RawBudget {
  budget_id: string;
  monthly_limit: number;
  max_task_allowance: number;
  task_ttl_seconds: number;
  cost_center: string;
  max_delegation_depth: number;
}

interface RawConfig {
  team: string;
  entity_id: string;
  budgets: Record<string, RawBudget>;
}

export function loadConfig(filePath: string): ScripConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as RawConfig;
  if (!raw?.team || !raw.entity_id || !raw.budgets) {
    throw new Error('Config must define team, entity_id, and budgets');
  }

  const budgets: Record<string, BudgetConfig> = {};
  for (const [name, budget] of Object.entries(raw.budgets)) {
    if (budget.monthly_limit <= 0 || budget.max_task_allowance <= 0) {
      throw new Error(`Budget "${name}" limits must be positive`);
    }
    if (budget.max_task_allowance > budget.monthly_limit) {
      throw new Error(`Budget "${name}" max_task_allowance cannot exceed monthly_limit`);
    }
    if (budget.max_delegation_depth <= 0) {
      throw new Error(`Budget "${name}" max_delegation_depth must be positive`);
    }
    budgets[name] = {
      budgetId: budget.budget_id,
      monthlyLimit: budget.monthly_limit,
      maxTaskAllowance: budget.max_task_allowance,
      taskTtlSeconds: budget.task_ttl_seconds,
      costCenter: budget.cost_center,
      maxDelegationDepth: budget.max_delegation_depth,
    };
  }

  return { team: raw.team, entityId: raw.entity_id, budgets };
}
