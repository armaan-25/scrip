import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Real MCP protocol round-trip: spawns bin/mcp-server.ts as a subprocess
// (exactly how Claude Code/Codex/Cursor would) and drives it over stdio -
// not a direct function call, the actual wire protocol.
async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'bin/mcp-server.ts'],
    env: { ...process.env, SCRIP_STORE: '.scrip/mcp-smoke-test.json' } as Record<string, string>,
  });

  const client = new Client({ name: 'scrip-smoke-test', version: '1.0.0' });
  await client.connect(transport);

  console.log('Connected to Scrip MCP server.\n');

  const { tools } = await client.listTools();
  console.log(
    'Tools:',
    tools.map((t) => t.name)
  );
  const expected = ['get_ramp_budget_policy', 'authorize_ai_task', 'delegate_task_allowance', 'settle_ai_task'];
  for (const name of expected) {
    if (!tools.some((t) => t.name === name)) throw new Error(`Missing expected tool: ${name}`);
  }
  console.log('All 4 expected tools present.\n');

  const policyResult = await client.callTool({
    name: 'get_ramp_budget_policy',
    arguments: { budget: 'research' },
  });
  console.log('get_ramp_budget_policy(research):', (policyResult.content as any)[0].text, '\n');

  const authResult = await client.callTool({
    name: 'authorize_ai_task',
    arguments: {
      budget: 'research',
      taskId: `mcp-smoke-${Date.now()}`,
      task: 'MCP smoke test task',
      allowance: 0.5,
    },
  });
  const authorized = JSON.parse((authResult.content as any)[0].text);
  console.log('authorize_ai_task ->', authorized.authorization.authorizationId, '\n');

  const delegateResult = await client.callTool({
    name: 'delegate_task_allowance',
    arguments: {
      parentCredential: authorized.credential,
      agentId: 'smoke-test-child',
      allowance: 0.1,
    },
  });
  console.log('delegate_task_allowance ->', (delegateResult.content as any)[0].text, '\n');

  const settleResult = await client.callTool({
    name: 'settle_ai_task',
    arguments: {
      authorizationId: authorized.authorization.authorizationId,
      outcomeStatus: 'success',
      outcomeEvidence: 'MCP smoke test completed',
    },
  });
  console.log('settle_ai_task ->', (settleResult.content as any)[0].text);

  await client.close();
  console.log('\nMCP smoke test passed: real protocol round-trip, all 4 tools, real server subprocess.');
}

main().catch((error) => {
  console.error('MCP smoke test FAILED:', error);
  process.exit(1);
});
