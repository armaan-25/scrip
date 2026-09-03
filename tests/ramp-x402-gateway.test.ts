import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { RampX402Executor } from '../src/ramp-x402-gateway.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const mockExecFile = vi.mocked(execFile);

const config = { cliBin: 'ramp', env: 'sandbox' as const };

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function encodeChallenge(challenge: unknown): string {
  return Buffer.from(JSON.stringify(challenge)).toString('base64url');
}

function encodeSettlement(settlement: unknown): string {
  return Buffer.from(JSON.stringify(settlement)).toString('base64url');
}

function fakeAccept(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    scheme: 'exact',
    network: SOLANA_MAINNET,
    asset: USDC_MINT,
    amount: '50000', // 0.05 USDC at 6 decimals
    payTo: 'somePayToAddress',
    extra: { feePayer: 'someFeePayer' },
    ...overrides,
  };
}

function mockDiscoveryThenSettled(accepts: unknown[], transaction = 'sol-tx-abc123') {
  const challengeHeader = encodeChallenge({ resource: 'https://api.exa.ai/search', accepts });
  const settlementHeader = encodeSettlement({ transaction });

  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const isRetry = (init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE'];
    if (isRetry) {
      return {
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'payment-response' ? settlementHeader : null) },
      } as unknown as Response;
    }
    return {
      status: 402,
      headers: { get: (name: string) => (name.toLowerCase() === 'payment-required' ? challengeHeader : null) },
    } as unknown as Response;
  });
}

function mockRampX402PaySuccess() {
  mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
    const callback = callArgs[callArgs.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
    const stdout = JSON.stringify({ payment_header_name: 'PAYMENT-SIGNATURE', payment_header_value: 'sig-xyz' });
    callback(null, stdout, '');
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

describe('RampX402Executor', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('requires resourceUrl before doing anything else', async () => {
    const executor = new RampX402Executor(config);
    await expect(executor.pay({ label: 'search', maximumCost: 0.1, merchant: 'exa.ai' })).rejects.toThrow(
      /requires resourceUrl/
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('pays a compatible challenge and returns the real Solana transaction hash', async () => {
    global.fetch = mockDiscoveryThenSettled([fakeAccept()]) as unknown as typeof fetch;
    mockRampX402PaySuccess();
    const executor = new RampX402Executor(config);

    const result = await executor.pay({
      label: 'search query',
      maximumCost: 0.1,
      merchant: 'exa.ai',
      resourceUrl: 'https://api.exa.ai/search',
      resourceBody: { query: 'test', numResults: 3 },
    });

    expect(result).toEqual({ transactionRef: 'sol-tx-abc123', rail: 'ramp-x402' });
    const [command, args] = mockExecFile.mock.calls[0];
    expect(command).toBe('ramp');
    expect(args).toEqual(['-e', 'sandbox', 'x402', 'pay', '--json', expect.any(String)]);
    if (!args) throw new Error('expected execFile to have been called with args');
    const paymentInput = JSON.parse(args[5] as string);
    expect(paymentInput.accepted).toEqual(fakeAccept());
    expect(paymentInput.resource).toBe('https://api.exa.ai/search');
    expect(paymentInput.rationale).toBe('Scrip reservation: search query');
  });

  it('refuses to pay when the challenge amount exceeds the authorized maximumCost', async () => {
    // 0.05 USDC challenge, but only $0.01 authorized
    global.fetch = mockDiscoveryThenSettled([fakeAccept()]) as unknown as typeof fetch;
    const executor = new RampX402Executor(config);

    await expect(
      executor.pay({
        label: 'search query',
        maximumCost: 0.01,
        merchant: 'exa.ai',
        resourceUrl: 'https://api.exa.ai/search',
      })
    ).rejects.toThrow(/exceeding the authorized/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects a challenge with no compatible accepts entry (wrong network, EVM instead of Solana)', async () => {
    global.fetch = mockDiscoveryThenSettled([
      fakeAccept({ network: 'eip155:8453', asset: '0xUSDCOnBase' }),
    ]) as unknown as typeof fetch;
    const executor = new RampX402Executor(config);

    await expect(
      executor.pay({ label: 'search', maximumCost: 1, merchant: 'exa.ai', resourceUrl: 'https://api.exa.ai/search' })
    ).rejects.toThrow(/No compatible x402 accepts entry/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws when the merchant does not actually return a 402', async () => {
    global.fetch = vi.fn(async () => ({ status: 200, headers: { get: () => null } }) as unknown as Response) as unknown as typeof fetch;
    const executor = new RampX402Executor(config);

    await expect(
      executor.pay({ label: 'search', maximumCost: 1, merchant: 'exa.ai', resourceUrl: 'https://api.exa.ai/search' })
    ).rejects.toThrow(/Expected HTTP 402/);
  });

  it('surfaces ramp x402 pay\'s real error message on failure', async () => {
    global.fetch = mockDiscoveryThenSettled([fakeAccept()]) as unknown as typeof fetch;
    mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
      const callback = callArgs[callArgs.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('Command failed'), 'insufficient wallet balance', '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
    const executor = new RampX402Executor(config);

    await expect(
      executor.pay({ label: 'search', maximumCost: 1, merchant: 'exa.ai', resourceUrl: 'https://api.exa.ai/search' })
    ).rejects.toThrow(/insufficient wallet balance/);
  });

  it('throws if the paid retry does not return 200', async () => {
    const challengeHeader = encodeChallenge({ resource: 'https://api.exa.ai/search', accepts: [fakeAccept()] });
    global.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const isRetry = (init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE'];
      if (isRetry) {
        return { status: 500, headers: { get: () => null } } as unknown as Response;
      }
      return {
        status: 402,
        headers: { get: (name: string) => (name.toLowerCase() === 'payment-required' ? challengeHeader : null) },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    mockRampX402PaySuccess();
    const executor = new RampX402Executor(config);

    await expect(
      executor.pay({ label: 'search', maximumCost: 1, merchant: 'exa.ai', resourceUrl: 'https://api.exa.ai/search' })
    ).rejects.toThrow(/Payment signed but retry/);
  });
});
