import { randomUUID } from 'node:crypto';
import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';

export interface CardIssueRequest {
  /** Human-readable label on the card - reservation label, so it's traceable back to the action that requested it. */
  displayName: string;
  /** Single-use cap in USD - the reservation's maximumCost. Ramp enforces this as the card's spending_restrictions.amount. */
  maximumAmountUsd: number;
  /** The merchant this card is meant for. Recorded on the reservation for audit; Ramp's own product auto-locks the card to whichever merchant runs the first transaction, not a value this API accepts up front. */
  merchant: string;
}

export interface IssuedCard {
  cardId: string;
  last4: string;
  state: string;
}

export interface CardIssuer {
  issueCard(request: CardIssueRequest): Promise<IssuedCard>;
}

export interface RampAgentCardConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  /** Real Ramp user the card is issued under - see docs/ramp-api-notes.md. */
  cardholderUserId: string;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mints a real single-use Ramp Agent Card via the deferred virtual-card task
 * endpoint (`POST /developer/v1/cards/deferred/virtual`, `cards:write`
 * scope). Unlike RampOAuthClient/RampApiGateway/Meter, this endpoint's exact
 * request/response field names have NOT been confirmed live against this
 * project's sandbox app the way OAuth/Funds/AI Usage Tracking were (see
 * docs/ramp-api-notes.md) - run scripts/smoke-test-agent-card.ts against a
 * real cards:write-scoped app before trusting the field names below in a
 * real purchase decision.
 */
export class RampAgentCardIssuer implements CardIssuer {
  private oauth: RampOAuthClient;

  constructor(private config: RampAgentCardConfig, private fetchFn: HttpFetch = fetch) {
    this.oauth = new RampOAuthClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenUrl: `${config.baseUrl}/developer/v1/token`,
        scope: 'cards:write',
      },
      fetchFn
    );
  }

  async issueCard(request: CardIssueRequest): Promise<IssuedCard> {
    const token = await this.oauth.getAccessToken();
    const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/cards/deferred/virtual`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: randomUUID(),
        user_id: this.config.cardholderUserId,
        display_name: request.displayName,
        spending_restrictions: {
          amount: Math.round(request.maximumAmountUsd * 100),
          interval: 'TOTAL',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ramp card issuance request failed with status ${response.status}`);
    }

    const body = (await response.json()) as { id: string };
    return this.pollForCard(token, body.id);
  }

  private async pollForCard(token: string, taskId: string): Promise<IssuedCard> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/cards/deferred/${taskId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Ramp card task status request failed with status ${response.status}`);
      }
      const body = (await response.json()) as {
        status: string;
        card?: { id: string; last4: string; state: string };
      };
      if (body.status === 'SUCCESS' && body.card) {
        return { cardId: body.card.id, last4: body.card.last4, state: body.card.state };
      }
      if (body.status === 'ERROR') {
        throw new Error(`Ramp card issuance task ${taskId} failed`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Ramp card issuance task ${taskId} did not complete within ${POLL_TIMEOUT_MS}ms`);
  }
}

/** Local, zero-network stand-in for RampAgentCardIssuer - used when no cards:write-scoped app is configured. Same role as MockRampGateway. */
export class MockCardIssuer implements CardIssuer {
  private counter = 0;

  async issueCard(_request: CardIssueRequest): Promise<IssuedCard> {
    this.counter += 1;
    return {
      cardId: `mock_card_${this.counter}`,
      last4: String(1000 + this.counter).slice(-4),
      state: 'ACTIVE',
    };
  }
}
