import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads the team and budget policy', () => {
    const config = loadConfig('scrip.yaml');
    expect(config.team).toBe('agent-platform');
    expect(config.entityId).toBe('scrip-demo');
    expect(config.budgets.research).toEqual({
      budgetId: 'budget-research',
      monthlyLimit: 100,
      maxTaskAllowance: 10,
      taskTtlSeconds: 900,
      costCenter: 'AI compute',
      maxDelegationDepth: 3,
    });
  });

  it('throws for a missing file', () => {
    expect(() => loadConfig('does-not-exist.yaml')).toThrow();
  });

  it('rejects a task allowance above the monthly limit', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-config-')), 'scrip.yaml');
    fs.writeFileSync(file, [
      'team: t', 'entity_id: e', 'budgets:', '  b:', '    budget_id: b', '    monthly_limit: 5',
      '    max_task_allowance: 10', '    task_ttl_seconds: 60', '    cost_center: c', '    max_delegation_depth: 1',
    ].join('\n'));
    expect(() => loadConfig(file)).toThrow(/cannot exceed monthly_limit/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
