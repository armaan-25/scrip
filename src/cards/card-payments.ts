/**
 * Adapts the SIMULATED issuer to the mission slice's PaymentCapabilityProvider,
 * so PurchaseMissionService is unchanged: the "capability" it hands the
 * agent is a single-use card reference.
 *
 * The binding's purchaseDigest is computed from the booking in the
 * ExecutionRequest. The service builds that request only after preflight()
 * has proven the candidate canonically equal to the approved purchase, so
 * the digest on the card is the digest of what the person approved. A test
 * (tests/simulated-rail.test.ts) asserts that equality against the mission.
 */
import type { ExecutionRequest, HotelBooking, PaymentCapabilityProvider, PaymentFact } from '../missions/types.js';
import { purchaseDigest } from './card-gate.js';
import type { SimulatedIssuer } from './simulated-rail.js';

export class CardPaymentCapabilityProvider implements PaymentCapabilityProvider {
  readonly label = 'SIMULATED card issuer (PaymentCapabilityProvider)';
  private cardsByOperation = new Map<string, string>();

  constructor(
    private issuer: SimulatedIssuer,
    /** Network-visible descriptors the approved merchant charges under. */
    private descriptorsFor: (booking: HotelBooking) => string[],
    private now: () => Date = () => new Date(),
  ) {}

  async issue(request: Omit<ExecutionRequest, 'capabilityRef'>): Promise<{ capabilityRef: string }> {
    const binding = this.issuer.issue({
      operationKey: request.operationKey,
      merchantId: request.booking.merchant,
      purchaseDigest: purchaseDigest(request.booking),
      merchantDescriptors: this.descriptorsFor(request.booking),
      ceiling: request.maximumCost,
      exactTotal: request.booking.total,
      currency: 'USD',
      notBefore: this.now().toISOString(),
      expiresAt: request.expiresAt,
      singleUse: true,
    });
    this.cardsByOperation.set(request.operationKey, binding.cardRef);
    return { capabilityRef: binding.cardRef };
  }

  async getFacts(operationKey: string): Promise<PaymentFact[]> { return this.issuer.facts(operationKey); }

  async revoke(operationKey: string): Promise<void> { this.issuer.freezeOperation(operationKey); }

  /**
   * Records that a refund was asked for. It does NOT produce a refund fact:
   * only the issuer's refund() (simulated provider evidence) does, which is
   * why the receipt shows refundPending until then.
   */
  async requestRecovery(request: { operationKey: string; recoveryKey: string; action: 'cancel' | 'refund' }): Promise<{ externalId: string }> {
    return { externalId: `simack_${request.recoveryKey}` };
  }

  cardFor(operationKey: string): string | undefined { return this.cardsByOperation.get(operationKey); }
}
