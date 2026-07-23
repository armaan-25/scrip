import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import chalk from 'chalk';
import { runCli, UsageError } from '../src/cli.js';
import { ScripRuntime } from '../src/runtime.js';

// Ramp's real brand accent, confirmed via brandcolorcode.com and Ramp's own
// design system docs ("a single highlighter-yellow signal against
// monochrome") - one yellow accent, everything else neutral, no other hues.
// See docs/superpowers/specs/2026-07-22-cli-styling-design.md.
const accent = chalk.hex('#E4F222');

function styleOutput(output: string): string {
  return output
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      const indent = line.slice(0, line.length - trimmed.length);
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) return chalk.gray(line);
      const label = trimmed.slice(0, colonIndex);
      const rest = trimmed.slice(colonIndex + 1);
      return `${indent}${accent(label)}:${chalk.white(rest)}`;
    })
    .join('\n');
}

async function main() {
  console.log(accent.bold('▲ SCRIP'));
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
  console.log(styleOutput(output));
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(chalk.gray(error.message));
  } else {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
  process.exit(1);
});
