import type { TaskEvidenceSnapshot } from './lease.js';
import { getModelPrice } from './pricing.js';
import type { ModelProvider, ProviderName } from './providers/model-provider.js';

export interface ControllerVerdict {
  approved: boolean;
  successProbability: number;
  reasoning: string;
}

function buildPrompt(evidence: TaskEvidenceSnapshot): string {
  return [
    'Evaluate whether this AI task should receive additional budget to continue.',
    '',
    `Task: ${evidence.task}`,
    `Allowance: $${evidence.allowance.toFixed(4)}`,
    `Spent so far: $${evidence.spent.toFixed(4)}`,
    `Pending: $${evidence.pending.toFixed(4)}`,
    `Requests completed: ${evidence.requestCount}`,
    `Active child agents: ${evidence.childAgents}`,
    `Elapsed time: ${evidence.elapsedSeconds.toFixed(0)}s`,
    `Model usage: ${JSON.stringify(evidence.modelUsage)}`,
    `Additional budget requested: $${evidence.requestedShortfall.toFixed(4)}`,
    '',
    'Estimate the probability (0 to 1) that granting this additional budget will ' +
      'result in the task completing successfully, based only on the evidence above.',
  ].join('\n');
}

/**
 * A separate model with no stake in the task's outcome, shown only a
 * structured evidence snapshot - never the worker's own chat history or
 * self-justification. Mirrors Ramp's own published research: numeric,
 * task-specific probability estimates get controllers to the right
 * decision; vague priors and injected "advice" don't. There is no
 * free-text field in TaskEvidenceSnapshot a recommendation could hide in.
 */
export class ApprovalController {
  constructor(private providers: Record<ProviderName, ModelProvider>, private model: string) {}

  async evaluate(evidence: TaskEvidenceSnapshot): Promise<ControllerVerdict> {
    const provider = this.providers[getModelPrice(this.model).provider as ProviderName];
    const { successProbability, reasoning } = await provider.renderVerdict({
      model: this.model,
      prompt: buildPrompt(evidence),
    });

    return { successProbability, reasoning, approved: successProbability > 0.5 };
  }
}
