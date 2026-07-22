import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { runCli, UsageError } from '../src/cli.js';
import { ScripRuntime } from '../src/runtime.js';

async function main() {
  const runtime = new ScripRuntime(
    process.env.SCRIP_CONFIG ?? 'scrip.yaml',
    process.env.SCRIP_STORE ?? '.scrip/ramp.json',
    undefined,
    // Every other ScripRuntime caller (MCP server, demo scripts) is one
    // long-running process end to end, so it never needed this. Each CLI
    // invocation is a fresh process, so authorize/settle/etc. only chain
    // correctly if lease state survives between them - see
    // docs/superpowers/plans/2026-07-22-cli-interface.md, Task 6 blocker.
    process.env.SCRIP_LEASE_STORE ?? '.scrip/leases.json'
  );
  const output = await runCli(runtime, process.argv.slice(2));
  console.log(output);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
