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

function fakeAnthropic(toolInput: { successProbability: number; reasoning: string }) {
  return {
    messages: {
      create: vi.fn(async () => ({
        id: 'msg_verdict',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'render_verdict', input: toolInput }],
      })),
    },
  } as any;
}

describe('ApprovalController', () => {
  it('approves when successProbability is above 0.5', async () => {
    const anthropic = fakeAnthropic({ successProbability: 0.8, reasoning: 'Task is nearly complete.' });
    const controller = new ApprovalController(anthropic, 'claude-sonnet-5');

    const verdict = await controller.evaluate(evidence());

    expect(verdict.approved).toBe(true);
    expect(verdict.successProbability).toBe(0.8);
    expect(verdict.reasoning).toBe('Task is nearly complete.');
  });

  it('denies when successProbability is at or below 0.5', async () => {
    const anthropic = fakeAnthropic({ successProbability: 0.5, reasoning: 'No clear evidence of progress.' });
    const controller = new ApprovalController(anthropic, 'claude-sonnet-5');

    const verdict = await controller.evaluate(evidence());

    expect(verdict.approved).toBe(false);
  });

  it('forces render_verdict tool use and never includes free-text advice in the prompt', async () => {
    const anthropic = fakeAnthropic({ successProbability: 0.9, reasoning: 'ok' });
    const controller = new ApprovalController(anthropic, 'claude-sonnet-5');

    await controller.evaluate(evidence());

    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5');
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'render_verdict' });
    expect(call.tools[0].name).toBe('render_verdict');
    // The prompt is built entirely from TaskEvidenceSnapshot fields - assert
    // the numbers actually appear, proving nothing else was smuggled in.
    const promptText = JSON.stringify(call.messages);
    expect(promptText).toContain('Review PR 418');
    expect(promptText).toContain('0.95');
  });

  it('throws if the controller does not return a render_verdict tool call', async () => {
    const anthropic = {
      messages: { create: vi.fn(async () => ({ id: 'msg_no_tool', content: [{ type: 'text', text: 'I refuse.' }] })) },
    } as any;
    const controller = new ApprovalController(anthropic, 'claude-sonnet-5');

    await expect(controller.evaluate(evidence())).rejects.toThrow(/render_verdict/);
  });
});
