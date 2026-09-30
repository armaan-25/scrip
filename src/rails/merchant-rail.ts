/**
 * Where an accepted checkout's money goes: a Natural wallet acting as the
 * merchant. The agent's purchase is settled as a real internal transfer on
 * the Natural sandbox, from the payer's default wallet to a wallet named
 * "Example Air (merchant)", at full price (sandbox money). Offline runs use
 * an in-memory stand-in with the same interface.
 */
import { NaturalClient } from '@naturalpay/sdk';

export interface Transfer { transferId: string; status: string; from: string; to: string }
export interface MerchantRail {
  mode: 'offline' | 'sandbox';
  pay(input: { amountCents: number; description: string; tags: Record<string, string>; idempotencyKey: string }): Promise<Transfer>;
}

const MERCHANT_WALLET = 'Example Air (merchant)';
const SANDBOX_URL = 'https://api.sandbox.natural.com';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'RETURNED', 'CANCELED', 'APPROVAL_DENIED']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class FakeMerchantRail implements MerchantRail {
  readonly mode = 'offline' as const;
  readonly transfers: (Transfer & { amountCents: number; tags: Record<string, string> })[] = [];
  failNext = false;
  async pay(input: { amountCents: number; tags: Record<string, string> }): Promise<Transfer> {
    const status = this.failNext ? 'FAILED' : 'COMPLETED';
    this.failNext = false;
    const transfer = { transferId: `trf_fake_${this.transfers.length + 1}`, status, from: 'Travel budget', to: MERCHANT_WALLET };
    this.transfers.push({ ...transfer, amountCents: input.amountCents, tags: input.tags });
    return transfer;
  }
}

interface WalletRow { id: string; attributes: { displayName?: string; isDefault?: boolean } }

export class NaturalMerchantRail implements MerchantRail {
  readonly mode = 'sandbox' as const;
  private client: NaturalClient;
  private wallets?: Promise<{ source: WalletRow; merchant: WalletRow }>;

  constructor(token: string, instanceId: string) {
    if (!token.startsWith('sk_ntl_sandbox_')) throw new Error('The merchant rail only runs on the Natural sandbox (sk_ntl_sandbox_ key)');
    this.client = new NaturalClient({ token, baseUrl: SANDBOX_URL, instanceId });
  }

  /** The payer's default wallet, and the merchant wallet (created once, found by name after). */
  private find(): Promise<{ source: WalletRow; merchant: WalletRow }> {
    return (this.wallets ??= (async () => {
      const list = (await this.client.wallets.list()) as unknown as { data: WalletRow[] };
      const source = list.data.find(w => w.attributes.isDefault) ?? list.data[0];
      if (!source) throw new Error('No wallet on the sandbox account');
      let merchant = list.data.find(w => w.attributes.displayName === MERCHANT_WALLET);
      if (!merchant) {
        const created = (await this.client.wallets.create({
          idempotencyKey: 'scrip-example-air-merchant-wallet', displayName: MERCHANT_WALLET,
          description: 'Stands in for the airline: receives accepted agent checkouts in the Scrip demo.',
          tags: { scrip_role: 'simulated_merchant' },
        })) as unknown as { data: WalletRow };
        merchant = created.data;
      }
      return { source, merchant };
    })());
  }

  async pay(input: { amountCents: number; description: string; tags: Record<string, string>; idempotencyKey: string }): Promise<Transfer> {
    const { source, merchant } = await this.find();
    const created = (await this.client.transfers.initiateInternal({
      idempotencyKey: input.idempotencyKey, amount: input.amountCents, sourceWalletId: source.id, destWalletId: merchant.id,
      description: input.description.slice(0, 80), tags: input.tags,
    })) as unknown as { data: { id: string; attributes: { status?: string } } };
    // Internal transfers start PROCESSING; wait for a final status so the page shows what really happened.
    let status = created.data.attributes.status ?? 'PROCESSING';
    const deadline = Date.now() + 60_000;
    while (!TERMINAL.has(status) && Date.now() < deadline) {
      await sleep(750);
      const detail = (await this.client.transfers.get({ transferId: created.data.id })) as unknown as { data: { attributes: { status?: string } } };
      status = detail.data.attributes.status ?? status;
    }
    return { transferId: created.data.id, status, from: source.attributes.displayName ?? 'Wallet', to: MERCHANT_WALLET };
  }
}

export function setupMerchantRail(mode: 'offline' | 'sandbox', runId: string): MerchantRail {
  if (mode === 'offline') return new FakeMerchantRail();
  return new NaturalMerchantRail(process.env.NATURAL_SANDBOX_API_KEY ?? '', runId);
}
