import { startMcpServer } from '../src/mcp-server.js';
import { SpecSpendRuntime } from '../src/runtime.js';

const runtime = new SpecSpendRuntime(
  process.env.SPECSPEND_CONFIG ?? 'specspend.yaml',
  process.env.SPECSPEND_STORE ?? '.specspend/ramp.json'
);
startMcpServer(runtime);
