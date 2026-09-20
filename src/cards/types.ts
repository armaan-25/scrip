/**
 * Card-rail types for the purchase-protection demo.
 *
 * Everything here is what a card ISSUER would hold or receive. Nothing here
 * references the mission service, the registry, or the mission store: if
 * the gate needs a fact, it must have been stamped on the CardBinding at
 * issuance, because that is the only channel an issuer has.
 *
 * All providers in this folder are SIMULATED. The type names say so.
 */
import type { HotelBooking } from '../missions/types.js';

/** What the issuer stores for one single-use card, at issuance. */
export interface CardBinding {
  cardRef: string;
  last4: string;
  operationKey: string;
  /** The merchant of record's id as the ledger names it (contract.purchase.merchant). */
  merchantId: string;
  /**
   * sha256(canonical(contract.purchase)) - the exact approved booking, not
   * the whole contract. A merchant can only hash the order it sees, so
   * this is the digest the order check compares against.
   */
  purchaseDigest: string;
  /** Network-visible merchant names allowed to charge this card. */
  merchantDescriptors: string[];
  /** Most this card may ever be charged (contract.maximumTotal). */
  ceiling: number;
  /** The approved purchase's exact total (contract.purchase.total). */
  exactTotal: number;
  currency: 'USD';
  notBefore: string;
  expiresAt: string;
  singleUse: true;
  status: 'active' | 'used' | 'frozen';
}

/**
 * An order the merchant sends to the issuer BEFORE authorization, signed
 * with a key the issuer and merchant share. Only merchants integrated with
 * the issuer can produce one. Its absence is the normal case for the
 * open web, and the gate must behave correctly without it.
 */
export interface SignedMerchantOrder {
  merchantId: string;
  orderRef: string;
  booking: HotelBooking;
  /** merchant-computed sha256(canonical(booking)); recomputed by the gate */
  digest: string;
  /** HMAC-SHA256 over (merchantId, orderRef, digest) with the shared key */
  signature: string;
}

/** What the network hands the issuer when a merchant runs the card. */
export interface CardAuthorizationRequest {
  cardRef: string;
  merchantDescriptor: string;
  mcc: string;
  amount: number;
  currency: 'USD';
  occurredAt: string;
  /** Present only when the merchant is integrated with the issuer. */
  order?: SignedMerchantOrder;
}

export type EnforcementTier = 'authorization' | 'order';

export type CardAuthorizationDecision =
  | { approved: true; tier: EnforcementTier; authRef: string }
  | { approved: false; tier: EnforcementTier; authRef: string; reasons: string[] };
