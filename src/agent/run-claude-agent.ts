/**
 * Runs Claude Code headless as a real purchasing agent. It gets Scrip's four
 * tools (over HTTP, tied to one trace) and, optionally, real web search and
 * fetch for research. No personal settings, hooks, or project files are
 * loaded: it runs in an empty temp folder with its own system prompt. Every
 * step it takes streams back as activity.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { AGENT_TOOLS } from './profiles.js';
import { type AgentActivity, parseStreamLine } from './stream-parser.js';

export interface ClaudeRunOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  mcpUrl: string;
  traceId: string;
  allowWeb: boolean;
  onActivity: (activity: AgentActivity) => void;
  timeoutMs?: number;
}

export async function runClaudeAgent(o: ClaudeRunOptions): Promise<{ exitCode: number | null; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-agent-'));
  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { scrip: { type: 'http', url: o.mcpUrl, headers: { 'X-Scrip-Trace': o.traceId } } } }));
  const webTools = o.allowWeb ? ['WebSearch', 'WebFetch'] : [];
  const args = [
    '-p', o.prompt,
    '--system-prompt', o.systemPrompt,
    '--model', o.model,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--setting-sources', '',
    '--tools', webTools.join(','),
    '--allowedTools', [...AGENT_TOOLS.map(t => `mcp__scrip__${t}`), ...webTools].join(','),
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '24',
    '--no-session-persistence',
  ];
  const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { for (const activity of parseStreamLine(line)) o.onActivity(activity); });
  const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 240_000);
  const exitCode = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  clearTimeout(timer);
  fs.rmSync(dir, { recursive: true, force: true });
  return { exitCode, stderr: stderr.slice(-2000) };
}
