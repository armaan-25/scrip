import { authorizeTask, settleTask } from '../src/handlers.js';
import { ScripClient } from '../src/proxy.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';
import { GithubPrOutcomeVerifier } from '../src/verifiers/github-pr-verifier.js';
import type { HttpFetch } from '../src/ramp-oauth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, no API key required - same reasoning as every other
// scripts/demo-*.ts: reproducible, free, and honest about which parts are
// real (every reservation/commit/release/revoke/settle call is the actual
// TaskAuthorizationManager/ScripClient code) versus stubbed (provider and
// GitHub responses).
//
// This is the flagship: one task, multiple concurrent workers, some
// admitted and some denied before any provider call, one worker using a
// non-inference paid action, two workers dispatching to different model
// providers under the same lease tree, unused capacity released back, a
// real (fake-fetch) outcome verification, and one settled receipt. It
// supersedes scripts/demo-scenario.ts, scripts/demo-generic-action.ts, and
// scripts/demo-cross-provider.ts, each of which proved one slice of this -
// see docs/PIVOT_AUDIT.md Sec 3 for why those were archived rather than
// kept redundant with this one.

function fakeProvider(name: string, inputTokens: number, outputTokens: number) {
  return {
    name,
    createMessage: async () => ({ content: `ok from ${name}`, inputTokens, outputTokens }),
    renderVerdict: async () => {
      throw new Error('not used in this demo');
    },
  };
}

function fakeGithubFetch(): HttpFetch {
  return (async (url: string | URL) => {
    const path = url.toString().replace('https://api.github.com', '');
    if (path.endsWith('/pulls/418')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ merged: true, merge_commit_sha: 'deadbeef', base: { ref: 'main' }, head: { sha: 'abc123' } }),
      } as Response;
    }
    if (path.includes('/commits/abc123/check-runs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          check_runs: [
            { name: 'ci/build', status: 'completed', conclusion: 'success' },
            { name: 'ci/test', status: 'completed', conclusion: 'success' },
          ],
        }),
      } as Response;
    }
    throw new Error(`fakeGithubFetch: no stub for ${path}`);
  }) as unknown as HttpFetch;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-flagship-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  const runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
  const anthropicProvider = fakeProvider('anthropic', 400, 250);
  const openaiProvider = fakeProvider('openai', 400, 250);
  const client = new ScripClient(runtime, { anthropic: anthropicProvider, openai: openaiProvider });

  const taskAllowance = 1.0;
  const task = await authorizeTask(runtime, {
    budget: 'cross_provider_demo',
    taskId: `flagship-${Date.now()}`,
    task: 'Ship a fix for the checkout incident',
    allowance: taskAllowance,
  });
  console.log(`Task authorized: $${taskAllowance.toFixed(2)} allowance on cross_provider_demo\n`);

  interface WorkerOutcome {
    workerId: string;
    kind: string;
    status: 'ran' | 'denied';
    detail: string;
  }
  const outcomes: WorkerOutcome[] = [];

  // Worker 1: real inference dispatch to the Anthropic provider.
  try {
    const child = runtime.authorizations.delegate(task.credential, 'worker-anthropic', 0.3);
    const result = await client.run({
      credential: child.credential,
      model: 'claude-sonnet-5',
      estimatedInputTokens: 400,
      maxTokens: 250,
      messages: [{ role: 'user', content: 'Diagnose the checkout failure.' }],
    });
    outcomes.push({ workerId: 'worker-anthropic', kind: 'inference (anthropic)', status: 'ran', detail: `model=${result.model} cost=$${result.actualCost.toFixed(6)}` });
  } catch (error) {
    outcomes.push({ workerId: 'worker-anthropic', kind: 'inference (anthropic)', status: 'denied', detail: String(error) });
  }

  // Worker 2: real inference dispatch to the OpenAI provider - same task
  // lease tree, different model provider, proving dispatch is by model
  // name (getModelPrice(model).provider), not by which SDK happens to be
  // wired in for the whole task.
  try {
    const child = runtime.authorizations.delegate(task.credential, 'worker-openai', 0.3);
    const result = await client.run({
      credential: child.credential,
      model: 'gpt-5.6-luna',
      estimatedInputTokens: 400,
      maxTokens: 250,
      messages: [{ role: 'user', content: 'Draft the incident postmortem.' }],
    });
    outcomes.push({ workerId: 'worker-openai', kind: 'inference (openai)', status: 'ran', detail: `model=${result.model} cost=$${result.actualCost.toFixed(6)}` });
  } catch (error) {
    outcomes.push({ workerId: 'worker-openai', kind: 'inference (openai)', status: 'denied', detail: String(error) });
  }

  // Worker 3: a non-inference paid action against the same lease, using
  // the generic EconomicAction primitive directly - the same atomicity
  // that gates a real provider call also gates an unrelated paid API call.
  try {
    const child = runtime.authorizations.delegate(task.credential, 'worker-paid-api', 0.3);
    const reservation = runtime.authorizations.reserveAction(child.credential, 'paid_api', 'incident_timeline_api', 0.05, {
      vendor: 'statuspage',
    });
    const actualCost = 0.031;
    runtime.authorizations.commitAction(reservation.reservationId, actualCost);
    outcomes.push({ workerId: 'worker-paid-api', kind: 'paid_api', status: 'ran', detail: `label=${reservation.label} cost=$${actualCost.toFixed(6)}` });
  } catch (error) {
    outcomes.push({ workerId: 'worker-paid-api', kind: 'paid_api', status: 'denied', detail: String(error) });
  }

  // Worker 4: intentionally oversubscribes the task. Three workers above
  // already reserved $0.90 of the $1.00 allowance; this one asks for
  // another $0.30, which the atomic reservation math rejects before any
  // provider or paid-API call happens.
  try {
    const child = runtime.authorizations.delegate(task.credential, 'worker-oversubscribed', 0.3);
    await client.run({
      credential: child.credential,
      model: 'claude-sonnet-5',
      estimatedInputTokens: 400,
      maxTokens: 250,
      messages: [{ role: 'user', content: 'This should never run.' }],
    });
    outcomes.push({ workerId: 'worker-oversubscribed', kind: 'inference (anthropic)', status: 'ran', detail: 'unexpected: should have been denied' });
  } catch (error) {
    outcomes.push({ workerId: 'worker-oversubscribed', kind: 'inference (anthropic)', status: 'denied', detail: error instanceof Error ? error.message : String(error) });
  }

  console.log('Four concurrent workers under one task lease:');
  for (const o of outcomes) {
    console.log(`  [${o.status.toUpperCase()}] ${o.workerId} (${o.kind}): ${o.detail}`);
  }
  console.log('');

  // Outcome verification: a real GithubPrOutcomeVerifier, given a fake
  // fetch so this demo needs no GITHUB_TOKEN - the verifier logic itself
  // (parsing merged/base.ref/check_runs) is exactly what runs against a
  // real GitHub repo, only the HTTP layer is stubbed.
  const verifier = new GithubPrOutcomeVerifier('demo-token', fakeGithubFetch());
  const evidence = await verifier.verify({
    owner: 'acme',
    repo: 'checkout-service',
    pullNumber: 418,
    requiredChecks: ['ci/build', 'ci/test'],
  });
  console.log(`Outcome verification (${evidence.type}): ${evidence.description}\n`);

  const ranCount = outcomes.filter((o) => o.status === 'ran').length;
  const receipt = await settleTask(runtime, task.authorization.authorizationId, {
    status: evidence.data?.checksPassed ? 'success' : 'partial',
    evidence: evidence.description,
    evidenceDetail: [evidence],
  });

  console.log(`Final receipt (${ranCount} of 4 workers ran, unused capacity released):`);
  console.log(
    JSON.stringify(
      {
        authorized: receipt.authorized,
        actual: receipt.actual,
        returned: receipt.returned,
        workerCount: receipt.workerCount,
        actionCount: receipt.actionCount,
        costs: receipt.costs,
        outcome: receipt.outcome,
        evidenceDetail: receipt.evidenceDetail,
      },
      null,
      2
    )
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
