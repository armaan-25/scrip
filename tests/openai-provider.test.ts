import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, type OpenAILike } from '../src/providers/openai-provider.js';

function fakeClient(response: unknown): OpenAILike {
  return { chat: { completions: { create: vi.fn(async () => response) } } } as unknown as OpenAILike;
}

describe('OpenAIProvider', () => {
  it('extracts message content and token usage from a chat completion', async () => {
    const client = fakeClient({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const provider = new OpenAIProvider(client);

    const result = await provider.createMessage({
      model: 'gpt-5.6-luna',
      maxTokens: 300,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual({ content: 'hello', inputTokens: 100, outputTokens: 50 });
  });

  it('forces render_verdict function-calling and parses its JSON arguments', async () => {
    const create = vi.fn(async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: { name: 'render_verdict', arguments: JSON.stringify({ successProbability: 0.8, reasoning: 'ok' }) },
              },
            ],
          },
        },
      ],
    }));
    const provider = new OpenAIProvider({ chat: { completions: { create } } } as unknown as OpenAILike);

    const verdict = await provider.renderVerdict({ model: 'gpt-5.6-luna', prompt: 'Evaluate this task.' });

    expect(verdict).toEqual({ successProbability: 0.8, reasoning: 'ok' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'function', function: { name: 'render_verdict' } },
        messages: [{ role: 'user', content: 'Evaluate this task.' }],
      })
    );
  });

  it('throws if no render_verdict tool call is returned', async () => {
    const client = fakeClient({ choices: [{ message: { content: 'I refuse.' } }] });
    const provider = new OpenAIProvider(client);

    await expect(provider.renderVerdict({ model: 'gpt-5.6-luna', prompt: 'Evaluate.' })).rejects.toThrow(/render_verdict/);
  });
});
