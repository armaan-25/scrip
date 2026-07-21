import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type AnthropicLike } from '../src/providers/anthropic-provider.js';

function fakeClient(response: unknown): AnthropicLike {
  return { messages: { create: vi.fn(async () => response) } } as unknown as AnthropicLike;
}

describe('AnthropicProvider', () => {
  it('extracts text content and token usage from a plain message', async () => {
    const client = fakeClient({
      id: 'msg_1',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'text', text: 'hello' }],
    });
    const provider = new AnthropicProvider(client);

    const result = await provider.createMessage({
      model: 'claude-sonnet-5',
      maxTokens: 300,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual({ content: 'hello', inputTokens: 100, outputTokens: 50 });
  });

  it('forces render_verdict tool use and extracts its structured input', async () => {
    const create = vi.fn(async () => ({
      id: 'msg_verdict',
      content: [{ type: 'tool_use', id: 'tool_1', name: 'render_verdict', input: { successProbability: 0.8, reasoning: 'ok' } }],
    }));
    const provider = new AnthropicProvider({ messages: { create } } as unknown as AnthropicLike);

    const verdict = await provider.renderVerdict({ model: 'claude-sonnet-5', prompt: 'Evaluate this task.' });

    expect(verdict).toEqual({ successProbability: 0.8, reasoning: 'ok' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: 'tool', name: 'render_verdict' },
        messages: [{ role: 'user', content: 'Evaluate this task.' }],
      })
    );
  });

  it('throws if no render_verdict tool call is returned', async () => {
    const client = fakeClient({ id: 'msg_no_tool', content: [{ type: 'text', text: 'I refuse.' }] });
    const provider = new AnthropicProvider(client);

    await expect(provider.renderVerdict({ model: 'claude-sonnet-5', prompt: 'Evaluate.' })).rejects.toThrow(/render_verdict/);
  });
});
