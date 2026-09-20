import { describe, expect, it } from 'vitest';
import { runProtectDemo, type ProtectDemoResult } from '../demo/protect.js';

let cached: Promise<ProtectDemoResult> | undefined;
const run = () => (cached ??= runProtectDemo(() => {}));

describe('Scrip purchase-protection demo: approve -> authorize -> verify -> recover', () => {
  it('1. a correct purchase at an integrated merchant succeeds from two independent evidence streams', async () => {
    const { correct, approval } = await run();
    expect(correct.decisions).toHaveLength(1);
    expect(correct.decisions[0]).toMatchObject({ approved: true, tier: 'order' });
    expect(correct.captureCount).toBe(1);
    expect(correct.assessment).toBe('success');
    expect(correct.receipt).toMatchObject({ captured: 500, unrecovered: 0, refunded: 0, refundPending: false, status: 'succeeded' });
    expect(approval.purchaseDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. merchant, amount, currency, and window violations are each declined with exactly one reason; the card is single use', async () => {
    const { violations } = await run();
    expect(violations.probeReasons).toEqual([
      ['Merchant descriptor not permitted'], ['Amount exceeds ceiling'], ['Currency mismatch'], ['Card window closed'], ['Card is used'],
    ]);
    expect(violations.captureCount).toBe(1);
    expect(violations.assessment).toBe('success');
  });

  it('3. same merchant, same price, different dates is declined before capture when the merchant sends an authenticated order', async () => {
    const { orderMismatch } = await run();
    expect(orderMismatch.forgedReasons).toEqual(['Merchant order signature invalid']);
    expect(orderMismatch.mismatchReasons).toEqual(['Order does not match the approved purchase']);
    expect(orderMismatch.decisions.every(d => !d.approved && d.tier === 'order')).toBe(true);
    expect(orderMismatch.captureCount).toBe(0);
    expect(orderMismatch.receipt).toMatchObject({ captured: 0, unrecovered: 0, status: 'cancelled' });
  });

  it('4. without merchant integration the charge passes, the mismatch is caught afterward, and refunds stay pending until funds post', async () => {
    const { noIntegration } = await run();
    for (const [openedBy, s] of Object.entries(noIntegration)) {
      expect(s.decisions[0]).toMatchObject({ approved: true, tier: 'authorization' });
      expect(s.captureCount).toBe(1);
      expect(s.receipt).toMatchObject({ captured: 500, unrecovered: 500, status: 'recovery_required' });
      expect(s.recovery?.packet.openedBy).toBe(openedBy);
      expect(s.recovery?.packet.mismatches).toEqual([expect.objectContaining({ source: 'email', fields: ['startsOn', 'endsOn'] })]);
      expect(s.recovery?.packet.purchaseDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(s.recovery?.packet.agentVersionId).toBeDefined();
      expect(s.recovery?.refundRequested).toBe(true);
      expect(s.finalReceipt).toMatchObject({ refunded: 500, unrecovered: 0, refundPending: false, status: 'refunded' });
    }
  });

  it('every scenario shares one approved purchase fingerprint, and the recovery packet carries it', async () => {
    const { approval, noIntegration } = await run();
    expect(noIntegration.detector.recovery?.packet.purchaseDigest).toBe(approval.purchaseDigest);
    expect(noIntegration.consumer.recovery?.packet.purchaseDigest).toBe(approval.purchaseDigest);
  });
});
