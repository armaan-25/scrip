import { describe, expect, it } from 'vitest';
import { parseStreamLine } from '../src/agent/stream-parser.js';

// Lines shaped like the CLI's stream-json output (recorded from a real run, trimmed).
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet-test', tools: ['mcp__scrip__search_flights'] }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't0', name: 'ToolSearch', input: { query: 'select:mcp__scrip__search_flights' } }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Searching now.' }, { type: 'tool_use', id: 't1', name: 'mcp__scrip__search_flights', input: { from: 'JFK', to: 'SFO' } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[{"offerId":"offer-nonstop"}]' }] }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.12, result: 'Bought offer-nonstop.' }),
  'not json',
];

describe('parseStreamLine', () => {
  it('turns the CLI stream into agent activity', () => {
    const all = lines.flatMap(parseStreamLine);
    expect(all).toEqual([
      { kind: 'init', model: 'sonnet-test' },
      { kind: 'tool_call', toolUseId: 't0', tool: 'ToolSearch', input: { query: 'select:mcp__scrip__search_flights' }, internal: true },
      { kind: 'message', text: 'Searching now.' },
      { kind: 'tool_call', toolUseId: 't1', tool: 'search_flights', input: { from: 'JFK', to: 'SFO' }, internal: false },
      { kind: 'tool_result', toolUseId: 't1', output: '[{"offerId":"offer-nonstop"}]', isError: false },
      { kind: 'tool_result', toolUseId: 't2', output: 'boom', isError: true },
      { kind: 'final', ok: true, turns: 3, costUsd: 0.12, text: 'Bought offer-nonstop.' },
    ]);
  });
});
