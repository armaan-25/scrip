import type Anthropic from '@anthropic-ai/sdk';
import type { TaskEvidenceSnapshot } from './lease.js';

export interface ControllerVerdict {
  approved: boolean;
  successProbability: number;
  reasoning: string;
}

type AnthropicLike = Pick<Anthropic, 'messages'>;

const RENDER_VERDICT_TOOL = {
  name: 'render_verdict',
  description: 'Render a scored verdict on whether to approve additional budget for a task.',
  input_schema: {
    type: 'object' as const,
    properties: {
      successProbability: {
        type: 'number',
        description: 'Probability, from 0 to 1, that granting the requested additional budget results in the task completing successfully.',
      },
      reasoning: {
        type: 'string',
        description: 'Brief reasoning grounded only in the evidence provided.',
      },
    },
    required: ['successProbability', 'reasoning'],
  },
};

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
  constructor(private anthropic: AnthropicLike, private model: string) {}

  async evaluate(evidence: TaskEvidenceSnapshot): Promise<ControllerVerdict> {
    const message = (await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 512,
      tools: [RENDER_VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'render_verdict' },
      messages: [{ role: 'user', content: buildPrompt(evidence) }],
    })) as Anthropic.Message;

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'render_verdict'
    );
    if (!toolUse) {
      throw new Error('Approval controller did not return a render_verdict tool call');
    }

    const input = toolUse.input as { successProbability: number; reasoning: string };
    return {
      successProbability: input.successProbability,
      reasoning: input.reasoning,
      approved: input.successProbability > 0.5,
    };
  }
}
