/**
 * Reads the agent's step-by-step output (the CLI's stream-json format, one
 * JSON object per line) and turns it into activity Scrip records: tool calls,
 * tool results, messages, and the final outcome. Unknown lines are ignored.
 */
export type AgentActivity =
  | { kind: 'init'; model: string }
  | { kind: 'tool_call'; toolUseId: string; tool: string; input: unknown; internal: boolean }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { kind: 'message'; text: string }
  | { kind: 'final'; ok: boolean; turns: number | null; costUsd: number | null; text: string };

const INTERNAL_TOOLS = new Set(['ToolSearch']);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Tool names arrive as mcp__<server>__<tool>; keep just the tool. */
const shortName = (name: string): string => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => str(obj(c).text) || JSON.stringify(c)).join('\n');
  return JSON.stringify(content ?? '');
}

export function parseStreamLine(line: string): AgentActivity[] {
  let msg: Record<string, unknown>;
  try { msg = obj(JSON.parse(line)); } catch { return []; }
  const type = str(msg.type);

  if (type === 'system' && msg.subtype === 'init') return [{ kind: 'init', model: str(msg.model) }];
  if (type === 'result') {
    return [{ kind: 'final', ok: msg.subtype === 'success' && msg.is_error !== true, turns: num(msg.num_turns), costUsd: num(msg.total_cost_usd), text: str(msg.result) }];
  }

  const content = obj(msg.message).content;
  if (!Array.isArray(content)) return [];
  const out: AgentActivity[] = [];
  for (const part of content.map(obj)) {
    if (type === 'assistant' && part.type === 'text' && str(part.text).trim()) out.push({ kind: 'message', text: str(part.text) });
    if (type === 'assistant' && part.type === 'tool_use') {
      const name = str(part.name);
      out.push({ kind: 'tool_call', toolUseId: str(part.id), tool: shortName(name), input: part.input ?? {}, internal: INTERNAL_TOOLS.has(name) });
    }
    if (type === 'user' && part.type === 'tool_result') {
      out.push({ kind: 'tool_result', toolUseId: str(part.tool_use_id), output: resultText(part.content), isError: part.is_error === true });
    }
  }
  return out;
}
