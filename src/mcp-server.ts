import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { SpendSpecRuntime } from './runtime.js';
import { estimateSpend, getSpendPolicy, recordUsage, requestMoreBudget } from './handlers.js';

export function createMcpServer(runtime: SpendSpecRuntime): McpServer {
  const server = new McpServer({ name: 'spendspec', version: '0.1.0' });

  server.tool(
    'get_spend_policy',
    'Get remaining budget and spend policy for a project/feature before starting a task.',
    { project: z.string(), feature: z.string() },
    async ({ project, feature }) => ({
      content: [{ type: 'text', text: JSON.stringify(getSpendPolicy(runtime, project, feature)) }],
    })
  );

  server.tool(
    'estimate_spend',
    'Estimate the dollar cost of a planned task given token counts and number of calls.',
    {
      project: z.string(),
      feature: z.string(),
      model: z.string(),
      estimatedInputTokens: z.number(),
      estimatedOutputTokens: z.number(),
      numCalls: z.number(),
    },
    async (params) => ({
      content: [{ type: 'text', text: JSON.stringify({ estimatedCost: estimateSpend(runtime, params) }) }],
    })
  );

  server.tool(
    'request_more_budget',
    'Request additional budget for a project/feature above its current limit.',
    { project: z.string(), feature: z.string(), amount: z.number(), reason: z.string() },
    async ({ project, feature, amount, reason }) => ({
      content: [{ type: 'text', text: JSON.stringify(requestMoreBudget(runtime, project, feature, amount, reason)) }],
    })
  );

  server.tool(
    'record_usage',
    'Record actual usage against a budget lease and emit a spend receipt.',
    {
      leaseId: z.string(),
      team: z.string(),
      task: z.string(),
      actualCost: z.number(),
      model: z.string(),
      costCenter: z.string(),
    },
    async (params) => {
      recordUsage(runtime, params);
      return { content: [{ type: 'text', text: JSON.stringify({ recorded: true }) }] };
    }
  );

  return server;
}

export async function startMcpServer(runtime: SpendSpecRuntime): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
