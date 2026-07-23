import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/interfaces/http/server.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let runtime: ScripRuntime;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-http-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
  server = startHttpServer(runtime, 0); // port 0 - the OS picks a free ephemeral port
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a real TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(pathAndQuery: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(`${baseUrl}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function get(pathAndQuery: string) {
  const response = await fetch(`${baseUrl}${pathAndQuery}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function authorizeTaskViaHttp(allowance = 1) {
  const { status, body } = await post('/v1/tasks', { budget: 'research', taskId: 'task-1', task: 'Review code', allowance });
  expect(status).toBe(201);
  return body as { credential: string; authorization: { authorizationId: string } };
}

describe('HTTP API', () => {
  it('POST /v1/tasks authorizes a real task over a real HTTP connection', async () => {
    const { status, body } = await post('/v1/tasks', {
      budget: 'research',
      taskId: 'task-1',
      task: 'Review code',
      allowance: 2,
    });
    expect(status).toBe(201);
    expect(body.credential).toMatch(/^scrip_/);
    expect(body.authorization.allowance).toBe(2);
  });

  it('POST /v1/tasks validates required fields with a 400 before touching any business logic', async () => {
    const { status, body } = await post('/v1/tasks', { budget: 'research' });
    expect(status).toBe(400);
    expect(body.error).toContain('taskId');
  });

  it('GET /v1/tasks/:taskId shows a task', async () => {
    const issued = await authorizeTaskViaHttp();
    const { status, body } = await get(`/v1/tasks/${issued.authorization.authorizationId}`);
    expect(status).toBe(200);
    expect(body.authorizationId).toBe(issued.authorization.authorizationId);
  });

  it('GET /v1/tasks/:taskId returns 404 for an unknown task', async () => {
    const { status, body } = await get('/v1/tasks/not-a-real-id');
    expect(status).toBe(404);
    expect(body.error).toContain('Unknown');
  });

  it('POST /v1/tasks/:taskId/delegate requires a Bearer credential', async () => {
    const issued = await authorizeTaskViaHttp();
    const { status, body } = await post(`/v1/tasks/${issued.authorization.authorizationId}/delegate`, {
      agentId: 'child-1',
      allowance: 0.3,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('Authorization');
  });

  it('POST /v1/tasks/:taskId/delegate delegates with a valid Bearer credential', async () => {
    const issued = await authorizeTaskViaHttp();
    const { status, body } = await post(
      `/v1/tasks/${issued.authorization.authorizationId}/delegate`,
      { agentId: 'child-1', allowance: 0.3 },
      { Authorization: `Bearer ${issued.credential}` }
    );
    expect(status).toBe(201);
    expect(body.credential).toMatch(/^scrip_/);
    expect(body.lease.depth).toBe(1);
  });

  it('GET /v1/tasks/:taskId/tree lists the delegation tree', async () => {
    const issued = await authorizeTaskViaHttp();
    await post(`/v1/tasks/${issued.authorization.authorizationId}/delegate`, { agentId: 'child-1', allowance: 0.3 }, {
      Authorization: `Bearer ${issued.credential}`,
    });
    const { status, body } = await get(`/v1/tasks/${issued.authorization.authorizationId}/tree`);
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it('the full action lifecycle: reserve returns 401 with an invalid credential', async () => {
    const { status } = await post(
      '/v1/actions/reserve',
      { actionType: 'paid_api', label: 'vendor_api', maximumCost: 0.1 },
      { Authorization: 'Bearer scrip_not-real' }
    );
    expect(status).toBe(401);
  });

  it('the full action lifecycle: reserve (402 over budget) -> reserve -> commit -> settle -> receipt', async () => {
    const issued = await authorizeTaskViaHttp(1);
    const auth = { Authorization: `Bearer ${issued.credential}` };

    const overBudget = await post('/v1/actions/reserve', { actionType: 'paid_api', label: 'x', maximumCost: 5 }, auth);
    expect(overBudget.status).toBe(402);

    const reserved = await post('/v1/actions/reserve', { actionType: 'paid_api', label: 'vendor_api', maximumCost: 0.3 }, auth);
    expect(reserved.status).toBe(201);
    expect(reserved.body.status).toBe('reserved');

    const committed = await post(`/v1/actions/${reserved.body.reservationId}/commit`, { actualCost: 0.21 });
    expect(committed.status).toBe(204);

    const settled = await post(`/v1/tasks/${issued.authorization.authorizationId}/settle`, {
      status: 'success',
      evidence: 'All checks passed',
    });
    expect(settled.status).toBe(200);
    expect(settled.body.actual).toBeCloseTo(0.21);
    expect(settled.body.outcome).toBe('success');

    const receipt = await get(`/v1/tasks/${issued.authorization.authorizationId}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.outcome).toBe('success');
  });

  it('POST /v1/actions/:actionId/cancel releases a reservation', async () => {
    const issued = await authorizeTaskViaHttp(1);
    const auth = { Authorization: `Bearer ${issued.credential}` };
    const reserved = await post('/v1/actions/reserve', { actionType: 'paid_api', label: 'vendor_api', maximumCost: 0.3 }, auth);

    const cancelled = await post(`/v1/actions/${reserved.body.reservationId}/cancel`);
    expect(cancelled.status).toBe(204);

    const task = await get(`/v1/tasks/${issued.authorization.authorizationId}`);
    expect(task.body.pending).toBeCloseTo(0);
  });

  it('POST /v1/tasks/:taskId/revoke revokes, and a later settle 404s', async () => {
    const issued = await authorizeTaskViaHttp(1);
    const revoked = await post(`/v1/tasks/${issued.authorization.authorizationId}/revoke`);
    expect(revoked.status).toBe(204);

    const settled = await post(`/v1/tasks/${issued.authorization.authorizationId}/settle`);
    expect(settled.status).toBe(400); // "Task authorization ... is not active" - not an "Unknown ..." message, so 400 not 404
  });
});
