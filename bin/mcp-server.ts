import { startMcpServer } from '../src/mcp-server.js';
import { ScripRuntime } from '../src/runtime.js';

const runtime = new ScripRuntime(
  process.env.SCRIP_CONFIG ?? 'scrip.yaml',
  process.env.SCRIP_STORE ?? '.scrip/ramp.json'
);
startMcpServer(runtime);
