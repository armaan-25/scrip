import { SpendSpecRuntime } from '../src/runtime.js';
import { startMcpServer } from '../src/mcp-server.js';

const runtime = new SpendSpecRuntime(
  process.env.SPENDSPEC_CONFIG ?? 'spendspec.yaml',
  process.env.SPENDSPEC_STORE ?? '.spendspec/store.json'
);
startMcpServer(runtime);
