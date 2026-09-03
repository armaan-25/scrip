import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecutedPayment, PaymentExecutionRequest, PaymentExecutor } from './payment-executor.js';

/** Same minimal promisified execFile as ramp-agent-card.ts's execFileCapturingStdout - see that file's comment for why this isn't util.promisify. Duplicated rather than shared/exported: each Ramp CLI adapter is deliberately self-contained. */
function execFileCapturingStdout(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        (error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout;
        (error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

export interface RampX402ExecutorConfig {
  /** Path to the real `ramp` CLI binary - same env var/config shape as RampCliCardIssuer. */
  cliBin: string;
  env: 'sandbox' | 'production';
}

/** x402's canonical payment-challenge shape - decoded from the merchant's base64url PAYMENT-REQUIRED header. Field names match the real protocol, not renamed for this codebase's conventions, since this JSON is handed verbatim to `ramp x402 pay`. */
interface X402Challenge {
  resource: string;
  accepts: X402Accept[];
  extensions?: Record<string, unknown> | null;
}

interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: { feePayer?: string };
}

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT_SOLANA_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

function decodeBase64UrlJson<T>(headerValue: string): T {
  const padded = headerValue + '='.repeat((4 - (headerValue.length % 4)) % 4);
  const json = Buffer.from(padded, 'base64url').toString('utf-8');
  return JSON.parse(json) as T;
}

function findAcceptedEntry(challenge: X402Challenge): X402Accept {
  const accepted = challenge.accepts.find(
    (entry) =>
      entry.scheme === 'exact' &&
      entry.network === SOLANA_MAINNET &&
      entry.asset === USDC_MINT_SOLANA_MAINNET &&
      Number(entry.amount) > 0 &&
      entry.extra?.feePayer
  );
  if (!accepted) {
    throw new Error(
      `No compatible x402 accepts entry (exact scheme, Solana mainnet, USDC, positive amount, feePayer) in challenge for ${challenge.resource}`
    );
  }
  return accepted;
}

/**
 * Real PaymentExecutor against Ramp's x402-managed Solana wallet - shells
 * out to `ramp x402 pay`, mirroring the real ramp-make-x402-payment skill's
 * flow: fetch the merchant's 402 challenge, validate it against x402's
 * exact/Solana-mainnet/USDC compatibility rules, pass the exact accepted
 * entry to Ramp for signing, then retry the original request with the
 * signed PAYMENT-SIGNATURE header. Requires an already-funded wallet (`ramp
 * x402 fund` - not done by this class, matches RampCliCardIssuer requiring
 * `ramp auth login` done externally).
 *
 * The one ceiling this rail has is enforced here, before ever calling
 * `ramp x402 pay`: the challenge's own quoted amount is checked against
 * request.maximumCost (which reserveWalletPayment() already validated
 * against the caller's remaining lease). If a merchant's real price exceeds
 * what Scrip authorized, this refuses to pay rather than letting the CLI
 * sign an over-budget transaction.
 */
export class RampX402Executor implements PaymentExecutor {
  constructor(private config: RampX402ExecutorConfig) {}

  async pay(request: PaymentExecutionRequest): Promise<ExecutedPayment> {
    if (!request.resourceUrl) {
      throw new Error('RampX402Executor requires resourceUrl - the merchant endpoint to fetch a 402 challenge from');
    }

    const requestInit: RequestInit = {
      method: 'POST',
      headers: request.resourceBody !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: request.resourceBody !== undefined ? JSON.stringify(request.resourceBody) : undefined,
    };

    const discovery = await fetch(request.resourceUrl, requestInit);
    if (discovery.status !== 402) {
      throw new Error(`Expected HTTP 402 from ${request.resourceUrl}, got ${discovery.status}`);
    }
    const challengeHeader = discovery.headers.get('payment-required');
    if (!challengeHeader) {
      throw new Error(`${request.resourceUrl} returned 402 with no PAYMENT-REQUIRED header`);
    }
    const challenge = decodeBase64UrlJson<X402Challenge>(challengeHeader);
    const accepted = findAcceptedEntry(challenge);

    const usdcAmount = Number(accepted.amount) / 10 ** USDC_DECIMALS;
    if (usdcAmount > request.maximumCost + Number.EPSILON) {
      throw new Error(
        `x402 challenge for ${challenge.resource} wants $${usdcAmount.toFixed(2)}, exceeding the authorized $${request.maximumCost.toFixed(2)}`
      );
    }

    const paymentInput = {
      accepted,
      resource: challenge.resource,
      extensions: challenge.extensions ?? null,
      idempotency_key: randomUUID(),
      rationale: `Scrip reservation: ${request.label}`,
    };

    let stdout: string;
    try {
      ({ stdout } = await execFileCapturingStdout(this.config.cliBin, [
        '-e',
        this.config.env,
        'x402',
        'pay',
        '--json',
        JSON.stringify(paymentInput),
      ]));
    } catch (error) {
      const stdoutFromError = (error as { stdout?: string }).stdout;
      throw new Error(`ramp x402 pay failed: ${stdoutFromError ?? (error as Error).message}`);
    }

    const result = JSON.parse(stdout) as { payment_header_name?: string; payment_header_value?: string };
    if (result.payment_header_name?.toLowerCase() !== 'payment-signature' || !result.payment_header_value) {
      throw new Error(`ramp x402 pay returned an unexpected result: ${stdout}`);
    }

    const settled = await fetch(request.resourceUrl, {
      ...requestInit,
      headers: { ...(requestInit.headers as Record<string, string> | undefined), 'PAYMENT-SIGNATURE': result.payment_header_value },
    });
    if (settled.status !== 200) {
      throw new Error(`Payment signed but retry to ${request.resourceUrl} returned ${settled.status}`);
    }
    const settlementHeader = settled.headers.get('payment-response');
    if (!settlementHeader) {
      throw new Error(`${request.resourceUrl} returned 200 with no PAYMENT-RESPONSE header after payment`);
    }
    const settlement = decodeBase64UrlJson<{ transaction?: string }>(settlementHeader);
    if (!settlement.transaction) {
      throw new Error(`PAYMENT-RESPONSE header had no transaction hash: ${settlementHeader}`);
    }

    return { transactionRef: settlement.transaction, rail: 'ramp-x402' };
  }
}
