import type Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ProviderMessage, ProviderResponse, VerdictToolResult } from './model-provider.js';

export type AnthropicLike = Pick<Anthropic, 'messages'>;

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

export class AnthropicProvider implements ModelProvider {
  constructor(private client: AnthropicLike) {}

  async createMessage(params: { model: string; maxTokens: number; messages: ProviderMessage[] }): Promise<ProviderResponse> {
    const message = (await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: params.messages,
    })) as Anthropic.Message;

    const textBlock = message.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    return {
      content: textBlock?.text ?? '',
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }

  async renderVerdict(params: { model: string; prompt: string }): Promise<VerdictToolResult> {
    const message = (await this.client.messages.create({
      model: params.model,
      max_tokens: 512,
      tools: [RENDER_VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'render_verdict' },
      messages: [{ role: 'user', content: params.prompt }],
    })) as Anthropic.Message;

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'render_verdict'
    );
    if (!toolUse) {
      throw new Error('Approval controller did not return a render_verdict tool call');
    }

    const input = toolUse.input as { successProbability: number; reasoning: string };
    return { successProbability: input.successProbability, reasoning: input.reasoning };
  }
}
