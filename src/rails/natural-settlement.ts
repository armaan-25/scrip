/**
 * LIVE Natural settlement for the purchase-protection demo.
 *
 * Natural has no card product yet, so the card, the issuer gate, and the
 * merchant order check stay SIMULATED. What Natural CAN do today is be the
 * money-facts boundary: every simulated capture becomes a real
 * wallet-to-wallet transfer on the account behind NATURAL_API_KEY, tagged
 * with the purchase fingerprint and operation key, and the payment fact
 * the mission ledger records carries Natural's transfer id and status.
 * Refunds are the reverse transfer. Money never leaves the account.
 *
 * Scale: the demo's ledger is in "$500 hotel" units; the real transfer is
 * $1.00 per capture (LIVE_CENTS). The fact's amount stays in ledger units
 * so the assessor's exact-total rule is exercised; the real amount and
 * scale are recorded in the transfer's tags.
 *
 * This is an evaluation of how a protection layer sits on Natural's rail.
 * It is not a product built on Natural.
 */
import { NaturalClient } from '@naturalpay/sdk';
import type { ExecutionRequest, PaymentCapabilityProvider, PaymentFact } from '../missions/types.js';
import type { CardPaymentCapabilityProvider } from '../cards/card-payments.js';
import type { SimulatedIssuer } from '../cards/simulated-rail.js';

const LIVE_CENTS = 100;
const MERCHANT_WALLET_NAME = 'Scrip demo: SIMULATED merchant settlement';

interface JsonApi<A> { data: { id: string; attributes: A } }
interface WalletAttrs { displayName?: string; balance?: { available?: number; total?: number } }
interface TransferAttrs { status?: string }

export interface LiveSettlement {
  operationKey: string;
  captureTransferId: string;
  captureStatus: string;
  refundTransferId?: string;
  refundStatus?: string;
  liveCents: number;
}

export class NaturalSettlementProvider implements PaymentCapabilityProvider {
  readonly label = 'LIVE Natural settlement (wallet-to-wallet, $1.00 per capture) over a SIMULATED issuer';
  private client: NaturalClient;
  private settlements = new Map<string, LiveSettlement>();
  private ready?: Promise<{ sourceWalletId: string; merchantWalletId: string }>;

  constructor(private inner: CardPaymentCapabilityProvider, private issuer: SimulatedIssuer, private instanceId: string) {
    if (!process.env.NATURAL_API_KEY) throw new Error('NATURAL_API_KEY is required for the live rail');
    this.client = new NaturalClient({ instanceId });
  }

  /** Finds the default wallet and creates (idempotently) the merchant wallet. */
  private wallets(): Promise<{ sourceWalletId: string; merchantWalletId: string }> {
    return (this.ready ??= (async () => {
      const list = (await this.client.wallets.list()) as unknown as { data: JsonApi<WalletAttrs>['data'][] | JsonApi<WalletAttrs>['data'] };
      const items = Array.isArray(list.data) ? list.data : [list.data];
      const source = items.find(w => (w.attributes as { isDefault?: boolean }).isDefault) ?? items[0];
      let merchant = items.find(w => w.attributes.displayName === MERCHANT_WALLET_NAME);
      if (!merchant) {
        const created = (await this.client.wallets.create({
          idempotencyKey: 'scrip-demo-merchant-wallet', displayName: MERCHANT_WALLET_NAME,
          description: 'Receives the live $1.00 settlement for each SIMULATED capture in the Scrip demo. Swept back at the start of every run.',
          tags: { scrip_role: 'simulated_merchant' },
        })) as unknown as JsonApi<WalletAttrs>;
        merchant = created.data;
      }
      return { sourceWalletId: source.id, merchantWalletId: merchant.id };
    })());
  }

  /** Returns whatever the merchant wallet holds to the source wallet, so each run nets to zero. */
  async sweepBack(): Promise<{ cents: number; transferId?: string }> {
    const { sourceWalletId, merchantWalletId } = await this.wallets();
    const detail = (await this.client.wallets.get({ walletId: merchantWalletId })) as unknown as JsonApi<WalletAttrs>;
    const cents = detail.data.attributes.balance?.available ?? 0;
    if (cents <= 0) return { cents: 0 };
    const transfer = (await this.client.transfers.initiateInternal({
      idempotencyKey: `scrip-demo-sweep-${Date.now()}`, amount: cents, sourceWalletId: merchantWalletId, destWalletId: sourceWalletId,
      description: 'Scrip demo reset: sweep simulated-merchant wallet back', tags: { scrip_role: 'demo_sweep' },
    })) as unknown as JsonApi<TransferAttrs>;
    return { cents, transferId: transfer.data.id };
  }

  async balances(): Promise<{ source: number; merchant: number }> {
    const { sourceWalletId, merchantWalletId } = await this.wallets();
    const read = async (id: string) => ((await this.client.wallets.get({ walletId: id })) as unknown as JsonApi<WalletAttrs>).data.attributes.balance?.available ?? 0;
    return { source: await read(sourceWalletId), merchant: await read(merchantWalletId) };
  }

  issue(request: Omit<ExecutionRequest, 'capabilityRef'>): Promise<{ capabilityRef: string }> { return this.inner.issue(request); }
  revoke(operationKey: string): Promise<void> { return this.inner.revoke(operationKey); }
  requestRecovery(request: { operationKey: string; recoveryKey: string; action: 'cancel' | 'refund' }): Promise<{ externalId: string }> {
    return this.inner.requestRecovery(request);
  }

  /**
   * For each simulated capture not yet settled, perform the live transfer
   * and rewrite the fact so its transactionRef/externalId are Natural's.
   * Simulated refunds are rewritten the same way once postRefund() ran.
   */
  async getFacts(operationKey: string): Promise<PaymentFact[]> {
    const facts = await this.inner.getFacts(operationKey);
    const out: PaymentFact[] = [];
    for (const fact of facts) {
      if (fact.kind === 'captured') {
        const live = await this.settleCapture(operationKey, fact);
        out.push({ ...fact, externalId: `natural:${live.captureTransferId}`, transactionRef: live.captureTransferId });
      } else if (fact.kind === 'refunded') {
        const live = this.settlements.get(operationKey);
        if (!live?.refundTransferId) continue; // not posted on Natural yet: not a fact
        out.push({ ...fact, externalId: `natural:${live.refundTransferId}`, transactionRef: live.captureTransferId });
      } else {
        out.push(fact);
      }
    }
    return out;
  }

  private async settleCapture(operationKey: string, fact: PaymentFact): Promise<LiveSettlement> {
    const existing = this.settlements.get(operationKey);
    if (existing) return existing;
    const { sourceWalletId, merchantWalletId } = await this.wallets();
    const binding = this.issuer.binding(this.inner.cardFor(operationKey) ?? '');
    const transfer = (await this.client.transfers.initiateInternal({
      idempotencyKey: `scrip-${operationKey}-capture`, amount: LIVE_CENTS, sourceWalletId, destWalletId: merchantWalletId,
      description: `Scrip demo capture ${fact.merchant} (ledger $${fact.amount.toFixed(2)})`.slice(0, 80),
      tags: {
        scrip_operation_key: operationKey, scrip_purchase_digest: binding?.purchaseDigest ?? 'unknown',
        scrip_ledger_amount: fact.amount.toFixed(2), scrip_scale: `${LIVE_CENTS}c_per_ledger_${fact.amount.toFixed(0)}`,
        scrip_kind: 'capture', scrip_rail_note: 'card and issuer are SIMULATED; this transfer is the money fact',
      },
    })) as unknown as JsonApi<TransferAttrs>;
    const detail = (await this.client.transfers.get({ transferId: transfer.data.id })) as unknown as JsonApi<TransferAttrs>;
    const live: LiveSettlement = {
      operationKey, captureTransferId: transfer.data.id, captureStatus: detail.data.attributes.status ?? transfer.data.attributes.status ?? 'unknown', liveCents: LIVE_CENTS,
    };
    this.settlements.set(operationKey, live);
    return live;
  }

  /** The merchant returns the funds: the reverse live transfer. Called by the demo as the "provider evidence" step. */
  async postRefund(operationKey: string): Promise<LiveSettlement> {
    const live = this.settlements.get(operationKey);
    if (!live) throw new Error('Nothing captured live for this operation');
    if (live.refundTransferId) return live;
    const { sourceWalletId, merchantWalletId } = await this.wallets();
    const transfer = (await this.client.transfers.initiateInternal({
      idempotencyKey: `scrip-${operationKey}-refund`, amount: live.liveCents, sourceWalletId: merchantWalletId, destWalletId: sourceWalletId,
      description: 'Scrip demo refund: merchant returns funds', tags: { scrip_operation_key: operationKey, scrip_kind: 'refund', scrip_refunds: live.captureTransferId },
    })) as unknown as JsonApi<TransferAttrs>;
    const detail = (await this.client.transfers.get({ transferId: transfer.data.id })) as unknown as JsonApi<TransferAttrs>;
    live.refundTransferId = transfer.data.id;
    live.refundStatus = detail.data.attributes.status ?? 'unknown';
    return live;
  }

  settlement(operationKey: string): LiveSettlement | undefined { return this.settlements.get(operationKey); }
}
