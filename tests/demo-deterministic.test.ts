import { describe, expect, it } from 'vitest';
import { runDemo } from '../demo/deterministic-authorization.js';

describe('deterministic authorization demo', () => {
  it('blocks the wrong-date candidate before any payment call and assesses outcomes from evidence', async () => {
    const result = await runDemo(() => {});
    expect(result.wrongDateReasons).toContain('Constraint mismatch: date_range');
    expect(result.issueCallsAfterWrongDate).toBe(0);
    expect(result.startCallsAfterWrongDate).toBe(0);
    expect(result.forgedCredentialRejected).toBe(true);
    expect(result.deliveredAssessment).toBe('success');
    expect(result.notDeliveredAssessment).toBe('failure');
    expect(result.unrecoveredBeforeRefund).toBe(500);
    expect(result.unrecoveredAfterRefund).toBe(0);
  });
});
