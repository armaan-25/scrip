import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { authorizeTask, settleTask, delegateTaskAllowance } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import type { ModelProvider } from '../src/providers/model-provider.js';
import { ScripRuntime } from '../src/runtime.js';

// Unlike visuals/live-server.ts (synthetic reserve/commit numbers), this one
// makes REAL Anthropic API calls - real tokens, real cost, real latency,
// real generated text. Same reason the other visuals servers exist
// separately from src/interfaces/http/server.ts: this is instrumentation
// for a demo, not part of the product surface.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8795);

type StreamEvent =
  | { type: 'authorized'; allowance: number }
  | { type: 'delegated'; agentId: string; allowance: number }
  | { type: 'thinking'; agentId: string }
  | { type: 'answered'; agentId: string; model: string; cost: number; preview: string }
  | { type: 'settled'; authorized: number; actual: number; returned: number }
  | { type: 'error'; message: string };

async function runScenario(send: (event: StreamEvent) => void) {
  const openaiProvider: ModelProvider = {
    createMessage: () => {
      throw new Error('OpenAI not configured for this demo');
    },
    renderVerdict: () => {
      throw new Error('OpenAI not configured for this demo');
    },
  };
  const runtime = new ScripRuntime('scrip.yaml', '.scrip/ramp.json');
  const client = new ScripClient(runtime, { anthropic: new AnthropicProvider(new Anthropic()), openai: openaiProvider });

  const task = await authorizeTask(runtime, {
    budget: 'research',
    taskId: `visual-real-${Date.now()}`,
    task: 'Research authentication libraries in this repository',
    allowance: 1,
  });
  send({ type: 'authorized', allowance: task.authorization.allowance });

  const prompts = [
    { agentId: 'researcher-1', prompt: 'In one short sentence, name one real risk of rolling your own session-token auth instead of using a library.' },
    { agentId: 'researcher-2', prompt: 'In one short sentence, name one real advantage of OAuth2 client-credentials flow over static API keys.' },
  ];

  await Promise.all(
    prompts.map(async ({ agentId, prompt }) => {
      const child = delegateTaskAllowance(runtime, { parentCredential: task.credential, agentId, allowance: 0.4 });
      send({ type: 'delegated', agentId, allowance: 0.4 });
      send({ type: 'thinking', agentId });
      const result = await client.run({
        credential: child.credential,
        estimatedInputTokens: 500,
        maxTokens: 120,
        messages: [{ role: 'user', content: prompt }],
      });
      send({
        type: 'answered',
        agentId,
        model: result.model,
        cost: result.actualCost,
        preview: result.content.slice(0, 160),
      });
    })
  );

  const receipt = await settleTask(runtime, task.authorization.authorizationId);
  send({ type: 'settled', authorized: receipt.authorized, actual: receipt.actual, returned: receipt.returned });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (event: StreamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await runScenario(send);
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/agents-real.html') {
    const html = fs.readFileSync(path.join(__dirname, 'agents-real.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[visuals] live REAL-inference tracker: http://localhost:${PORT}`);
});
