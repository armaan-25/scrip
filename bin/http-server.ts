import { existsSync } from 'node:fs';
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { startHttpServer } from '../src/interfaces/http/server.js';
import { ScripRuntime } from '../src/runtime.js';

const port = Number(process.env.PORT ?? 8787);
const runtime = new ScripRuntime(
  process.env.SCRIP_CONFIG ?? 'scrip.yaml',
  process.env.SCRIP_STORE ?? '.scrip/ramp.json',
  undefined,
  process.env.SCRIP_LEASE_STORE ?? '.scrip/leases.json'
);

startHttpServer(runtime, port);
console.log(`[http] scrip listening on :${port}`);
