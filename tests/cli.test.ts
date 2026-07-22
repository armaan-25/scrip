import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, UsageError } from '../src/cli.js';
import { ScripRuntime } from '../src/runtime.js';
import { MockRampGateway } from '../src/store.js';

let tmpDir: string;
let runtime: ScripRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-cli-'));
  const ramp = new MockRampGateway(path.join(tmpDir, 'ramp.json'));
  runtime = new ScripRuntime('scrip.yaml', path.join(tmpDir, 'unused.json'), ramp);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('runCli status', () => {
  it('prints budget policy fields for a known budget', async () => {
    const output = await runCli(runtime, ['status', 'research']);
    expect(output).toContain('rampBudgetId: ramp-budget-research');
    expect(output).toContain('monthlyLimit: $100.0000');
    expect(output).toContain('reportedSpend: $0.0000');
    expect(output).toContain('availableToAuthorize: $100.0000');
    expect(output).toContain('maxTaskAllowance: $10.0000');
    expect(output).toContain('allowedModels: claude-sonnet-5, claude-haiku-4-5-20251001');
    expect(output).toContain('fallbackModel: claude-haiku-4-5-20251001');
    expect(output).toContain('onLimit: deny');
  });

  it('throws for an unknown budget', async () => {
    await expect(runCli(runtime, ['status', 'not-a-real-budget'])).rejects.toThrow(/Unknown Ramp budget/);
  });

  it('throws a UsageError when the budget argument is missing', async () => {
    await expect(runCli(runtime, ['status'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError for an unknown command', async () => {
    await expect(runCli(runtime, ['not-a-command'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when no command is given', async () => {
    await expect(runCli(runtime, [])).rejects.toThrow(UsageError);
  });
});

describe('runCli authorize', () => {
  it('authorizes a task and prints the credential and authorizationId', async () => {
    const output = await runCli(runtime, [
      'authorize',
      'research',
      'task-1',
      '2',
      'Review',
      'authentication',
      'code',
    ]);
    expect(output).toContain('credential: scrip_');
    expect(output).toMatch(/authorizationId: [0-9a-f-]{36}/);
    expect(output).toContain('allowance: $2.0000');
    expect(output).toContain('task: Review authentication code');
  });

  it('throws a UsageError when fewer than 4 arguments are given', async () => {
    await expect(runCli(runtime, ['authorize', 'research', 'task-1', '2'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when the allowance is not a number', async () => {
    await expect(
      runCli(runtime, ['authorize', 'research', 'task-1', 'not-a-number', 'Review code'])
    ).rejects.toThrow(UsageError);
  });
});

describe('runCli delegate', () => {
  it('delegates a child allowance and prints the child credential', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const parentCredential = issued.match(/credential: (\S+)/)![1];

    const output = await runCli(runtime, ['delegate', parentCredential, 'child-1', '0.5']);
    expect(output).toContain('credential: scrip_');
    expect(output).toContain('allowance: $0.5000');
    expect(output).toContain('depth: 1');
  });

  it('throws a UsageError when arguments are missing', async () => {
    await expect(runCli(runtime, ['delegate', 'some-credential', 'child-1'])).rejects.toThrow(UsageError);
  });

  it('throws for an invalid parent credential', async () => {
    await expect(runCli(runtime, ['delegate', 'not-a-real-credential', 'child-1', '0.5'])).rejects.toThrow();
  });
});

describe('runCli settle', () => {
  it('settles a task and prints the receipt summary', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, [
      'settle',
      authorizationId,
      '--status',
      'success',
      '--evidence',
      'All checks passed',
    ]);
    expect(output).toContain('actual: $0.0000');
    expect(output).toContain('returned: $1.0000');
    expect(output).toContain('requestCount: 0');
    expect(output).toContain('outcome: success');
    expect(output).toContain('outcomeEvidence: All checks passed');
  });

  it('settles a task with no outcome flags, defaulting to unknown', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, ['settle', authorizationId]);
    expect(output).toContain('outcome: unknown');
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['settle'])).rejects.toThrow(UsageError);
  });

  it('throws for an unknown authorizationId', async () => {
    await expect(runCli(runtime, ['settle', 'not-a-real-id'])).rejects.toThrow();
  });
});

describe('runCli revoke', () => {
  it('revokes a task and confirms it', async () => {
    const issued = await runCli(runtime, ['authorize', 'research', 'task-1', '1', 'Review code']);
    const authorizationId = issued.match(/authorizationId: (\S+)/)![1];

    const output = await runCli(runtime, ['revoke', authorizationId]);
    expect(output).toBe(`Revoked authorization ${authorizationId}`);

    // A revoked authorization can no longer be settled.
    await expect(runCli(runtime, ['settle', authorizationId])).rejects.toThrow();
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['revoke'])).rejects.toThrow(UsageError);
  });

  it('throws for an unknown authorizationId', async () => {
    await expect(runCli(runtime, ['revoke', 'not-a-real-id'])).rejects.toThrow();
  });
});
