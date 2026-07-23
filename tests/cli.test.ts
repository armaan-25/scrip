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

async function authorizeRoot(allowance = 1) {
  const output = await runCli(runtime, ['task', 'authorize', 'research', 'task-1', String(allowance), 'Review code']);
  return {
    credential: output.match(/credential: (\S+)/)![1],
    authorizationId: output.match(/authorizationId: (\S+)/)![1],
  };
}

describe('runCli top-level dispatch', () => {
  it('throws a UsageError when no noun is given', async () => {
    await expect(runCli(runtime, [])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError for an unknown noun', async () => {
    await expect(runCli(runtime, ['not-a-noun'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError for an unknown verb under a known noun', async () => {
    await expect(runCli(runtime, ['task', 'not-a-verb'])).rejects.toThrow(UsageError);
    await expect(runCli(runtime, ['action', 'not-a-verb'])).rejects.toThrow(UsageError);
    await expect(runCli(runtime, ['receipt', 'not-a-verb'])).rejects.toThrow(UsageError);
    await expect(runCli(runtime, ['budget', 'not-a-verb'])).rejects.toThrow(UsageError);
  });
});

describe('runCli budget status', () => {
  it('prints budget policy fields for a known budget', async () => {
    const output = await runCli(runtime, ['budget', 'status', 'research']);
    expect(output).toContain('rampBudgetId: ramp-budget-research');
    expect(output).toContain('monthlyLimit: $100.0000');
    expect(output).toContain('allowedModels: claude-sonnet-5, claude-haiku-4-5-20251001');
    expect(output).toContain('onLimit: deny');
  });

  it('throws for an unknown budget', async () => {
    await expect(runCli(runtime, ['budget', 'status', 'not-a-real-budget'])).rejects.toThrow(/Unknown Ramp budget/);
  });

  it('throws a UsageError when the budget argument is missing', async () => {
    await expect(runCli(runtime, ['budget', 'status'])).rejects.toThrow(UsageError);
  });
});

describe('runCli task authorize', () => {
  it('authorizes a task and prints the credential and authorizationId', async () => {
    const output = await runCli(runtime, ['task', 'authorize', 'research', 'task-1', '2', 'Review', 'authentication', 'code']);
    expect(output).toContain('credential: scrip_');
    expect(output).toMatch(/authorizationId: [0-9a-f-]{36}/);
    expect(output).toContain('allowance: $2.0000');
    expect(output).toContain('task: Review authentication code');
  });

  it('throws a UsageError when fewer than 4 arguments are given', async () => {
    await expect(runCli(runtime, ['task', 'authorize', 'research', 'task-1', '2'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when the allowance is not a number', async () => {
    await expect(
      runCli(runtime, ['task', 'authorize', 'research', 'task-1', 'not-a-number', 'Review code'])
    ).rejects.toThrow(UsageError);
  });
});

describe('runCli task delegate', () => {
  it('delegates a child allowance and prints the child credential', async () => {
    const root = await authorizeRoot(1);
    const output = await runCli(runtime, ['task', 'delegate', root.credential, 'child-1', '0.5']);
    expect(output).toContain('credential: scrip_');
    expect(output).toContain('allowance: $0.5000');
    expect(output).toContain('depth: 1');
  });

  it('throws a UsageError when arguments are missing', async () => {
    await expect(runCli(runtime, ['task', 'delegate', 'some-credential', 'child-1'])).rejects.toThrow(UsageError);
  });

  it('throws for an invalid parent credential', async () => {
    await expect(runCli(runtime, ['task', 'delegate', 'not-a-real-credential', 'child-1', '0.5'])).rejects.toThrow();
  });
});

describe('runCli task show', () => {
  it('prints a task authorization', async () => {
    const root = await authorizeRoot(1);
    const output = await runCli(runtime, ['task', 'show', root.authorizationId]);
    expect(output).toContain(`authorizationId: ${root.authorizationId}`);
    expect(output).toContain('status: active');
    expect(output).toContain('allowance: $1.0000');
  });

  it('throws for an unknown authorizationId', async () => {
    await expect(runCli(runtime, ['task', 'show', 'not-a-real-id'])).rejects.toThrow();
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['task', 'show'])).rejects.toThrow(UsageError);
  });
});

describe('runCli task tree', () => {
  it('prints the root lease and every delegated child, indented by depth', async () => {
    const root = await authorizeRoot(1);
    await runCli(runtime, ['task', 'delegate', root.credential, 'child-1', '0.3']);

    const output = await runCli(runtime, ['task', 'tree', root.authorizationId]);
    const lines = output.split('\n');
    expect(lines[0]).toContain('[depth 0] root');
    expect(lines[1]).toContain('[depth 1] child-1');
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('reports no leases for an unknown authorizationId rather than throwing', async () => {
    const output = await runCli(runtime, ['task', 'tree', 'not-a-real-id']);
    expect(output).toContain('No leases found');
  });
});

describe('runCli task settle', () => {
  it('settles a task and prints the receipt summary', async () => {
    const root = await authorizeRoot(1);
    const output = await runCli(runtime, ['task', 'settle', root.authorizationId, '--status', 'success', '--evidence', 'All checks passed']);
    expect(output).toContain('actual: $0.0000');
    expect(output).toContain('returned: $1.0000');
    expect(output).toContain('workerCount: 0');
    expect(output).toContain('actionCount: 0');
    expect(output).toContain('outcome: success');
    expect(output).toContain('outcomeEvidence: All checks passed');
  });

  it('settles a task with no outcome flags, defaulting to unknown', async () => {
    const root = await authorizeRoot(1);
    const output = await runCli(runtime, ['task', 'settle', root.authorizationId]);
    expect(output).toContain('outcome: unknown');
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['task', 'settle'])).rejects.toThrow(UsageError);
  });
});

describe('runCli task revoke', () => {
  it('revokes a task and confirms it', async () => {
    const root = await authorizeRoot(1);
    const output = await runCli(runtime, ['task', 'revoke', root.authorizationId]);
    expect(output).toBe(`Revoked authorization ${root.authorizationId}`);
    await expect(runCli(runtime, ['task', 'settle', root.authorizationId])).rejects.toThrow();
  });

  it('throws a UsageError when the authorizationId is missing', async () => {
    await expect(runCli(runtime, ['task', 'revoke'])).rejects.toThrow(UsageError);
  });
});

describe('runCli action reserve/commit/cancel', () => {
  it('reserves, commits, and cancels a generic economic action', async () => {
    const root = await authorizeRoot(1);

    const reserveOutput = await runCli(runtime, ['action', 'reserve', root.credential, 'paid_api', 'vendor_api', '0.1']);
    expect(reserveOutput).toContain('status: reserved');
    const reservationId = reserveOutput.match(/reservationId: (\S+)/)![1];

    const commitOutput = await runCli(runtime, ['action', 'commit', reservationId, '0.07']);
    expect(commitOutput).toBe(`Committed ${reservationId}: $0.0700`);

    const reserve2 = await runCli(runtime, ['action', 'reserve', root.credential, 'paid_api', 'vendor_api', '0.1']);
    const reservationId2 = reserve2.match(/reservationId: (\S+)/)![1];
    const cancelOutput = await runCli(runtime, ['action', 'cancel', reservationId2]);
    expect(cancelOutput).toBe(`Cancelled ${reservationId2}`);
  });

  it('throws a UsageError for an invalid actionType', async () => {
    const root = await authorizeRoot(1);
    await expect(runCli(runtime, ['action', 'reserve', root.credential, 'not-a-type', 'label', '0.1'])).rejects.toThrow(UsageError);
  });

  it('throws a UsageError when reserve arguments are missing', async () => {
    await expect(runCli(runtime, ['action', 'reserve', 'cred', 'paid_api'])).rejects.toThrow(UsageError);
  });
});

describe('runCli receipt show/export', () => {
  it('shows a settled receipt', async () => {
    const root = await authorizeRoot(1);
    await runCli(runtime, ['task', 'settle', root.authorizationId, '--status', 'success']);

    const output = await runCli(runtime, ['receipt', 'show', root.authorizationId]);
    expect(output).toContain('outcome: success');
    expect(output).toContain('costs:');
  });

  it('throws when no receipt has been settled yet', async () => {
    const root = await authorizeRoot(1);
    await expect(runCli(runtime, ['receipt', 'show', root.authorizationId])).rejects.toThrow(/No settled receipt/);
  });

  it('exports a receipt to a JSON file', async () => {
    const root = await authorizeRoot(1);
    await runCli(runtime, ['task', 'settle', root.authorizationId, '--status', 'success']);

    const outPath = path.join(tmpDir, 'exported-receipt.json');
    const output = await runCli(runtime, ['receipt', 'export', root.authorizationId, outPath]);
    expect(output).toBe(`Exported receipt for ${root.authorizationId} to ${outPath}`);

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(written.authorizationId).toBe(root.authorizationId);
    expect(written.outcome).toBe('success');
  });
});
