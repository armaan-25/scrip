/**
 * A payment rail with no per-call ceiling of its own - unlike CardIssuer
 * (ramp-agent-card.ts), which mints a fresh instrument capped at
 * maximumAmountUsd, a PaymentExecutor spends against an already-funded pool
 * (e.g. a business-wide Ramp-managed Solana wallet via x402: `ramp x402
 * fund` moves USDC in once, `ramp x402 pay` spends against that balance
 * with no per-agent limit - Ramp only checks whether the wallet has enough
 * USDC. See docs/x402-notes.md for the real primitive this models).
 *
 * That means the caller (TaskAuthorizationManager.reserveWalletPayment)
 * carries the entire spend ceiling itself via reserveAction()'s atomic
 * reservation math - a PaymentExecutor implementation is never asked to
 * enforce a cap, because the rail underneath has no way to.
 */
export interface PaymentExecutionRequest {
  /** Human-readable label, traceable back to the reservation that requested it. */
  label: string;
  /**
   * Scrip's own ceiling, already enforced by reserveAction() before pay() is
   * ever called. For an x402-style executor this is also the last real
   * check against the rail itself: the merchant's 402 challenge names its
   * own price, and an implementation must refuse to pay a challenge that
   * exceeds this - the rail has no ceiling of its own to fall back on.
   */
  maximumCost: number;
  /** The merchant/resource this payment is for. Recorded for audit only. */
  merchant: string;
  /**
   * The HTTP endpoint to pay, for rails that require fetching a live
   * payment challenge before paying (x402's 402 Payment Required flow).
   * Optional because MockPaymentExecutor and any non-challenge-based rail
   * don't need it.
   */
  resourceUrl?: string;
  /**
   * The exact request body to send to resourceUrl, both for the initial
   * 402 discovery call and the paid retry - x402 requires replaying the
   * identical request once payment is signed, so this must be the real
   * request the caller wants to make (e.g. a search query), not a stand-in.
   */
  resourceBody?: unknown;
}

export interface ExecutedPayment {
  /** Rail-specific settlement reference - for ramp-x402, the Solana transaction signature. */
  transactionRef: string;
  /** Which rail actually executed this - lets a receipt distinguish "card" spend from "wallet" spend. */
  rail: string;
}

export interface PaymentExecutor {
  pay(request: PaymentExecutionRequest): Promise<ExecutedPayment>;
}

/** Zero-network fallback, used when no real executor is configured - mirrors MockCardIssuer in ramp-agent-card.ts. */
export class MockPaymentExecutor implements PaymentExecutor {
  private counter = 0;

  async pay(_request: PaymentExecutionRequest): Promise<ExecutedPayment> {
    this.counter += 1;
    return {
      transactionRef: `mock-tx-${this.counter}`,
      rail: 'mock',
    };
  }
}
