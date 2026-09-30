/**
 * The must-have checker: a separate, small Claude call (headless Claude Code,
 * no tools) that compares one checked-out item against each plain-language
 * must-have and answers yes / no / unsure with a one-line reason. It sees
 * only the item as the agent described it, never the agent's reasoning.
 * If it fails or answers in the wrong shape, every must-have is "unsure",
 * which sends the checkout to review rather than letting it through.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MustCheck, PurchaseItem } from './purchase.js';

export type JudgeRunner = (prompt: string) => Promise<string>;
export interface JudgeResult { checks: MustCheck[]; model: string; error?: string }

export const JUDGE_MODEL = 'haiku';
const SYSTEM = `You check whether an item a shopping agent chose meets a customer's must-haves.
You see only the item's description, not the product itself. For each must-have answer:
- "yes" if the description clearly meets it,
- "no" if the description clearly contradicts it,
- "unsure" if the description does not say.
Reply with only a JSON array: [{"must": "...", "verdict": "yes|no|unsure", "reason": "one short sentence"}], one entry per must-have, in order.`;

export function judgePrompt(item: PurchaseItem, musts: string[]): string {
  return `Item:\n${JSON.stringify({ merchant: item.merchant, item: item.item, details: item.details, quantity: item.quantity, totalUsd: item.totalCents / 100 }, null, 1)}\n\nMust-haves:\n${musts.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
}

/** Read the checker's reply into one check per must-have; anything missing or malformed becomes unsure. */
export function parseJudgeReply(reply: string, musts: string[]): MustCheck[] {
  const match = /\[[\s\S]*\]/.exec(reply);
  let rows: unknown[] = [];
  try { rows = match ? (JSON.parse(match[0]) as unknown[]) : []; } catch { rows = []; }
  return musts.map((must, i) => {
    const row = rows[i] && typeof rows[i] === 'object' ? (rows[i] as Record<string, unknown>) : {};
    const verdict = row.verdict === 'yes' || row.verdict === 'no' || row.verdict === 'unsure' ? row.verdict : 'unsure';
    return { must, verdict, reason: typeof row.reason === 'string' && row.reason ? row.reason.slice(0, 200) : 'the checker gave no usable answer' };
  });
}

export const claudeJudge: JudgeRunner = prompt => new Promise(resolve => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-judge-'));
  const child = spawn('claude', [
    '-p', prompt, '--system-prompt', SYSTEM, '--model', JUDGE_MODEL, '--tools', '', '--strict-mcp-config',
    '--setting-sources', '', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence',
  ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  child.on('close', () => {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
    try { resolve(String((JSON.parse(out) as { result?: unknown }).result ?? '')); } catch { resolve(''); }
  });
});

export async function judgeMusts(item: PurchaseItem, musts: string[], run: JudgeRunner = claudeJudge): Promise<JudgeResult> {
  if (!musts.length) return { checks: [], model: JUDGE_MODEL };
  try {
    const reply = await run(judgePrompt(item, musts));
    return { checks: parseJudgeReply(reply, musts), model: JUDGE_MODEL, ...(reply ? {} : { error: 'no reply from the checker' }) };
  } catch (error) {
    return { checks: parseJudgeReply('', musts), model: JUDGE_MODEL, error: (error as Error).message };
  }
}
