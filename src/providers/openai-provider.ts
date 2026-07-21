import type OpenAI from 'openai';
import type { ModelProvider, ProviderMessage, ProviderResponse, VerdictToolResult } from './model-provider.js';

export type OpenAILike = Pick<OpenAI, 'chat'>;

const RENDER_VERDICT_FUNCTION = {
  name: 'render_verdict',
  description: 'Render a scored verdict on whether to approve additional budget for a task.',
  parameters: {
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

export class OpenAIProvider implements ModelProvider {
  constructor(private client: OpenAILike) {}

  async createMessage(params: { model: string; maxTokens: number; messages: ProviderMessage[] }): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: params.messages,
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  async renderVerdict(params: { model: string; prompt: string }): Promise<VerdictToolResult> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: 512,
      tools: [{ type: 'function', function: RENDER_VERDICT_FUNCTION }],
      tool_choice: { type: 'function', function: { name: 'render_verdict' } },
      messages: [{ role: 'user', content: params.prompt }],
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.find(
      (call) => call.type === 'function' && call.function.name === 'render_verdict'
    );
    if (!toolCall || toolCall.type !== 'function') {
      throw new Error('Approval controller did not return a render_verdict tool call');
    }

    const input = JSON.parse(toolCall.function.arguments) as { successProbability: number; reasoning: string };
    return { successProbability: input.successProbability, reasoning: input.reasoning };
  }
}
