import fs from 'node:fs';
import yaml from 'js-yaml';

export interface FeatureConfig {
  monthlyBudget: number;
  maxPerRequest: number;
  allowedModels: string[];
  fallbackModel: string;
  onLimit: 'degrade' | 'request-approval' | 'throw';
}

export interface ProjectConfig {
  monthlyBudget: number;
  warningThreshold: number;
  features: Record<string, FeatureConfig>;
}

export interface SpendConfig {
  team: string;
  projects: Record<string, ProjectConfig>;
}

interface RawFeature {
  monthly_budget: number;
  max_per_request: number;
  allowed_models: string[];
  fallback_model: string;
  on_limit: 'degrade' | 'request-approval' | 'throw';
}

interface RawProject {
  monthly_budget: number;
  warning_threshold: number;
  features: Record<string, RawFeature>;
}

interface RawConfig {
  team: string;
  projects: Record<string, RawProject>;
}

export function loadConfig(filePath: string): SpendConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as RawConfig;

  const projects: Record<string, ProjectConfig> = {};
  for (const [projectName, rawProject] of Object.entries(raw.projects)) {
    const features: Record<string, FeatureConfig> = {};
    for (const [featureName, rawFeature] of Object.entries(rawProject.features)) {
      features[featureName] = {
        monthlyBudget: rawFeature.monthly_budget,
        maxPerRequest: rawFeature.max_per_request,
        allowedModels: rawFeature.allowed_models,
        fallbackModel: rawFeature.fallback_model,
        onLimit: rawFeature.on_limit,
      };
    }
    projects[projectName] = {
      monthlyBudget: rawProject.monthly_budget,
      warningThreshold: rawProject.warning_threshold,
      features,
    };
  }

  return { team: raw.team, projects };
}
