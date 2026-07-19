import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { authorizeTask, delegateTaskAllowance, getBudgetPolicy, settleTask } from './handlers.js';
import type { ScripRuntime } from './runtime.js';

/** Optional agent adapter. The runtime credential API remains the product boundary. */
export function createMcpServer(runtime: ScripRuntime): McpServer {
  const server = new McpServer({ name: 'scrip', version: '0.2.0' });

  server.tool(
    'get_ramp_budget_policy',
    'Read the Ramp-backed policy available for task authorization.',
    { budget: z.string() },
    async ({ budget }) => ({
      content: [{ type: 'text', text: JSON.stringify(getBudgetPolicy(runtime, budget)) }],
    })
  );

  server.tool(
    'authorize_ai_task',
    'Mint one temporary inference credential backed by a Ramp budget.',
    { budget: z.string(), taskId: z.string(), task: z.string(), allowance: z.number().positive() },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify(authorizeTask(runtime, params)) }],
    })
  );

  server.tool(
    'delegate_task_allowance',
    'Create a bounded child-agent lease from a task credential.',
    { parentCredential: z.string(), agentId: z.string(), allowance: z.number().positive() },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify(delegateTaskAllowance(runtime, params)) }],
    })
  );

  server.tool(
    'settle_ai_task',
    'Close a task authorization, emit its receipt, and report usage to Ramp.',
    { authorizationId: z.string() },
    async ({ authorizationId }) => ({
      content: [{ type: 'text', text: JSON.stringify(settleTask(runtime, authorizationId)) }],
    })
  );

  return server;
}

export async function startMcpServer(runtime: ScripRuntime): Promise<void> {
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
