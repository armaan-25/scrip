import { describe, expect, it, vi } from 'vitest';
import { ApprovalController } from '../src/approval-controller.js';
import type { TaskEvidenceSnapshot } from '../src/lease.js';

function evidence(overrides: Partial<TaskEvidenceSnapshot> = {}): TaskEvidenceSnapshot {
  return {
    task: 'Review PR 418',
    allowance: 1,
    spent: 0.95,
    pending: 0,
    requestCount: 4,
    childAgents: 1,
    elapsedSeconds: 120,
    modelUsage: [{ model: 'claude-sonnet-5', requests: 4, inputTokens: 2000, outputTokens: 900, cost: 0.95 }],
    requestedShortfall: 0.1,
    ...overrides,
  };
}

function fakeProviders(toolInput: { successProbability: number; reasoning: string }) {
  const renderVerdict = vi.fn(async () => toolInput);
  const createMessage = vi.fn();
  const provider = { createMessage, renderVerdict };
  return { anthropic: provider, openai: provider, renderVerdict } as any;
}

describe('ApprovalController', () => {
  it('approves when successProbability is above 0.5', async () => {
    const providers = fakeProviders({ successProbability: 0.8, reasoning: 'Task is nearly complete.' });
    const controller = new ApprovalController(providers, 'claude-sonnet-5');

    const verdict = await controller.evaluate(evidence());

    expect(verdict.approved).toBe(true);
    expect(verdict.successProbability).toBe(0.8);
    expect(verdict.reasoning).toBe('Task is nearly complete.');
  });

  it('denies when successProbability is at or below 0.5', async () => {
    const providers = fakeProviders({ successProbability: 0.5, reasoning: 'No clear evidence of progress.' });
    const controller = new ApprovalController(providers, 'claude-sonnet-5');

    const verdict = await controller.evaluate(evidence());

    expect(verdict.approved).toBe(false);
  });

  it('resolves the provider from the configured model and never includes free-text advice in the prompt', async () => {
    const providers = fakeProviders({ successProbability: 0.9, reasoning: 'ok' });
    const controller = new ApprovalController(providers, 'claude-sonnet-5');

    await controller.evaluate(evidence());

    expect(providers.renderVerdict).toHaveBeenCalledOnce();
    const call = providers.renderVerdict.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5');
    // The prompt is built entirely from TaskEvidenceSnapshot fields - assert
    // the numbers actually appear, proving nothing else was smuggled in.
    expect(call.prompt).toContain('Review PR 418');
    expect(call.prompt).toContain('0.95');
  });

  it('resolves to the OpenAI provider when the configured controller model is an OpenAI model', async () => {
    const anthropicRenderVerdict = vi.fn();
    const openaiRenderVerdict = vi.fn(async () => ({ successProbability: 0.7, reasoning: 'ok' }));
    const providers = {
      anthropic: { createMessage: vi.fn(), renderVerdict: anthropicRenderVerdict },
      openai: { createMessage: vi.fn(), renderVerdict: openaiRenderVerdict },
    } as any;
    const controller = new ApprovalController(providers, 'gpt-5.6-luna');

    const verdict = await controller.evaluate(evidence());

    expect(verdict.approved).toBe(true);
    expect(openaiRenderVerdict).toHaveBeenCalledOnce();
    expect(anthropicRenderVerdict).not.toHaveBeenCalled();
  });

  it('propagates an error if the provider does not return a verdict', async () => {
    const providers = {
      anthropic: {
        createMessage: vi.fn(),
        renderVerdict: vi.fn(async () => {
          throw new Error('Approval controller did not return a render_verdict tool call');
        }),
      },
      openai: { createMessage: vi.fn(), renderVerdict: vi.fn() },
    } as any;
    const controller = new ApprovalController(providers, 'claude-sonnet-5');

    await expect(controller.evaluate(evidence())).rejects.toThrow(/render_verdict/);
  });
});
