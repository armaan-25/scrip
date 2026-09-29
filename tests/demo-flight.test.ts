import { describe, expect, it } from 'vitest';
import { runFlightTraceDemo } from '../demo/flight-trace.js';

describe('flight trace demo (offline)', () => {
  it('pays the faithful agent, blocks the misreading one, denies the switching one', async () => {
    const result = await runFlightTraceDemo({ mode: 'offline', log: () => {} });
    expect(result.scenarios.map(s => [s.name, s.outcome, s.finalStatus])).toEqual([
      ['faithful', 'paid', 'COMPLETED'],
      ['misreads', 'blocked_before_payment', undefined],
      ['switches', 'denied_at_payment', 'APPROVAL_DENIED'],
    ]);
  });
});
