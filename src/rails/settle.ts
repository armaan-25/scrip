/**
 * After an agent pays: poll until the connector decides the hold (new holds
 * can take a moment to appear in Natural's list), then record a final status
 * only once it is final. A denied hold is final even though the sandbox leaves
 * the payment record at IN_REVIEW when the denial carries a reason.
 */
import type { FlightTraceService } from '../trace/trace-service.js';
import type { NaturalHoldConnector } from './natural-hold-connector.js';
import { type NaturalPort, TERMINAL_STATUSES } from './natural-port.js';

export type SettleOutcome = 'paid' | 'denied_at_payment' | 'undecided';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function waitForTerminal(owner: NaturalPort, paymentId: string): Promise<string> {
  let status = 'unknown';
  for (let i = 0; i < 20; i++) {
    status = await owner.getPaymentStatus(paymentId);
    if (TERMINAL_STATUSES.has(status)) return status;
    await sleep(500);
  }
  return status;
}

export async function settlePayment(
  service: FlightTraceService, connector: NaturalHoldConnector, owner: NaturalPort,
  traceId: string, paymentId: string, log: (line?: string) => void,
): Promise<{ outcome: SettleOutcome; finalStatus?: string }> {
  const decisionFor = () => service.events(traceId).find(e => e.type === 'hold_decided' && e.data.paymentId === paymentId);
  for (let i = 0; i < 20 && !decisionFor(); i++) {
    const poll = await connector.pollOnce();
    for (const error of poll.errors) log(`  connector error (will retry): ${error}`);
    if (!decisionFor()) await sleep(500);
  }
  const decided = decisionFor();
  if (decided?.type !== 'hold_decided') return { outcome: 'undecided' };
  const observed = await waitForTerminal(owner, paymentId);
  if (decided.data.decision === 'denied') {
    const note = TERMINAL_STATUSES.has(observed) ? undefined : `hold denied on Natural; payment record still shows ${observed}`;
    service.recordSettlement(traceId, { paymentId, status: 'APPROVAL_DENIED', note });
    return { outcome: 'denied_at_payment', finalStatus: 'APPROVAL_DENIED' };
  }
  if (!TERMINAL_STATUSES.has(observed)) return { outcome: 'undecided', finalStatus: observed };
  service.recordSettlement(traceId, { paymentId, status: observed });
  return { outcome: observed === 'COMPLETED' ? 'paid' : 'denied_at_payment', finalStatus: observed };
}
