import type Anthropic from '@anthropic-ai/sdk';
import type { SpendSpecRuntime } from './runtime.js';
import { computeCost } from './pricing.js';
import { SpendLimitExceededError } from './lease.js';
import { requestMoreBudget } from './handlers.js';

export interface RunOptions {
  project: string;
  feature: string;
  task: string;
  team: string;
  costCenter: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  maxTokens: number;
  messages: Anthropic.MessageParam[];
}

export interface RunResult {
  model: string;
  actualCost: number;
  degraded: boolean;
  message: Anthropic.Message;
}

type AnthropicLike = Pick<Anthropic, 'messages'>;

export class SpendSpecClient {
  constructor(private runtime: SpendSpecRuntime, private anthropic: AnthropicLike) {}

  async run(options: RunOptions): Promise<RunResult> {
    const { featureConfig } = this.runtime.getFeatureConfig(options.project, options.feature);
    const mostExpensive = [...featureConfig.allowedModels].sort(
      (a, b) => computeCost(b, 1, 1) - computeCost(a, 1, 1)
    )[0];
    const estimate = computeCost(mostExpensive, options.estimatedInputTokens, options.estimatedOutputTokens);
    const remaining = this.runtime.leaseManager.getRemainingBudget(options.project, options.feature);

    let model = this.runtime.router.route({
      remainingBudget: remaining,
      taskEstimate: estimate,
      allowedModels: featureConfig.allowedModels,
      fallbackModel: featureConfig.fallbackModel,
    });

    const reservedAmount = computeCost(model, options.estimatedInputTokens, options.estimatedOutputTokens) * 1.2;

    const lease = this.runtime.leaseManager.reserve(options.project, options.feature, reservedAmount);

    let degraded = false;
    let message = await this.callModel(model, options);
    let actualCost = computeCost(model, message.usage.input_tokens, message.usage.output_tokens);

    if (actualCost > lease.reservedAmount) {
      if (featureConfig.onLimit === 'degrade' && model !== featureConfig.fallbackModel) {
        model = featureConfig.fallbackModel;
        degraded = true;
        message = await this.callModel(model, options);
        actualCost = computeCost(model, message.usage.input_tokens, message.usage.output_tokens);
      } else if (featureConfig.onLimit === 'request-approval') {
        const shortfall = actualCost - lease.reservedAmount;
        const result = requestMoreBudget(
          this.runtime,
          options.project,
          options.feature,
          shortfall,
          `Overrun on task "${options.task}"`
        );
        if (!result.approved) {
          throw new SpendLimitExceededError(
            `Task "${options.task}" exceeded its $${lease.reservedAmount.toFixed(4)} lease and approval is pending`
          );
        }
      } else {
        throw new SpendLimitExceededError(
          `Task "${options.task}" exceeded its $${lease.reservedAmount.toFixed(4)} lease`
        );
      }
    }

    this.runtime.leaseManager.recordSpend(lease.leaseId, actualCost);
    this.runtime.store.addReceipt({
      team: options.team,
      project: options.project,
      feature: options.feature,
      task: options.task,
      authorized: lease.reservedAmount,
      actual: actualCost,
      model,
      costCenter: options.costCenter,
      timestamp: new Date().toISOString(),
    });
    this.runtime.leaseManager.release(lease.leaseId);

    return { model, actualCost, degraded, message };
  }

  private async callModel(model: string, options: RunOptions): Promise<Anthropic.Message> {
    return this.anthropic.messages.create({
      model,
      max_tokens: options.maxTokens,
      messages: options.messages,
    }) as Promise<Anthropic.Message>;
  }
}
