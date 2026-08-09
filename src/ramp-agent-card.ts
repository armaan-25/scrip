import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RampOAuthClient, type HttpFetch } from './ramp-oauth.js';

/**
 * A minimal, explicit promisified execFile - deliberately not
 * `util.promisify(execFile)`. Node's child_process module attaches a
 * custom `util.promisify.custom` implementation to the real execFile that
 * resolves `{stdout, stderr}` and attaches both onto a rejected error;
 * that behavior is undocumented-looking at the call site and doesn't
 * survive mocking execFile in tests (a plain vi.fn() replacement doesn't
 * carry the custom-promisify symbol, so generic promisify semantics would
 * apply instead and silently resolve to the wrong shape). Only `stdout` is
 * ever needed here, so this makes the real contract explicit instead of
 * leaning on that special-cased behavior.
 */
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

export interface CardIssueRequest {
  /** Human-readable label on the card - reservation label, so it's traceable back to the action that requested it. */
  displayName: string;
  /** Single-use cap in USD - the reservation's maximumCost. Ramp enforces this as the card's spending_restrictions.amount. */
  maximumAmountUsd: number;
  /** The merchant this card is meant for. Recorded on the reservation for audit only - not confirmed whether Ramp's Card Vault API accepts an upfront merchant restriction (its request schema exposes allowed_categories, not an explicit merchant/vendor field, as far as this project's research has confirmed). */
  merchant: string;
  /** The real Ramp Fund this card draws from - required by RampCliCardIssuer (ramp funds creds needs a fund id), ignored by the other issuers. Resolved by TaskAuthorizationManager.reserveCardPurchase() from the reservation's budget's ramp_fund_id in scrip.yaml. */
  fundId?: string;
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

/**
 * Mints a real single-use Ramp card via the Card Vault creation endpoint
 * (`POST /developer/v1/cards/vault`, `cards:read_vault` + `limits:write`
 * scopes, confirmed against Ramp's real OpenAPI spec after an earlier
 * implementation turned out to be built against a `/cards/deferred/virtual`
 * path that never existed at all - see docs/ramp-api-notes.md).
 *
 * IMPORTANT - this is NOT Ramp's Agent Cards product, and structurally
 * cannot become it. Ramp's own docs (docs.ramp.com/developer-api/v1/
 * build-for-ai-agents) draw an explicit line: "Virtual cards — non-agent
 * virtual cards (Vault API or embedded iframe) for human-driven flows" is
 * a distinct product line from Agent Cards. Real Agent Card issuance
 * (ramp_get_agent_card_creds over MCP, or the CLI's agentic-purchase
 * skill) is built on `https://api.ramp.com/agent-tools`, which those same
 * docs state plainly is "not accessible to external clients" - there is no
 * direct client-credentials REST call a third-party app can make to mint
 * a real Agent Card, no matter what scope is requested. Getting a real
 * Agent Card would mean either (a) shelling out to the real `ramp-cli`
 * binary's `agentic-purchase` skill as a subprocess, or (b) Scrip itself
 * acting as an MCP client against `https://mcp.ramp.com/mcp` - neither is
 * implemented here. This class mints a real Vault card instead: same
 * "single-use payment instrument capped at a reservation" shape
 * `reserveCardPurchase()` needs, issued through the product Ramp actually
 * lets third-party server-to-server clients touch.
 *
 * Current live status: every request to `/cards/vault` (full body, and a
 * minimal body with only the schema's one required field) returns the
 * same invariant `400 DEVELOPER_7098` "incorrect base URL" error, even
 * with the correct scope confirmed present in the token. A real "wrong
 * scope" error looks different on this API (`403 DEVELOPER_7100`, names
 * the missing scope) - ruled out directly, not assumed. Ramp's own
 * changelog describes this endpoint as gated to "vault API access
 * holders," a business-level entitlement separate from the OAuth scope,
 * normally requiring a PCI-qualification support ticket - one has been
 * filed. See docs/ramp-api-notes.md for the full trail.
 */
export class RampAgentCardIssuer implements CardIssuer {
  private oauth: RampOAuthClient;

  constructor(private config: RampAgentCardConfig, private fetchFn: HttpFetch = fetch) {
    this.oauth = new RampOAuthClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenUrl: `${config.baseUrl}/developer/v1/token`,
        scope: 'cards:read_vault limits:write',
      },
      fetchFn
    );
  }

  async issueCard(request: CardIssueRequest): Promise<IssuedCard> {
    const token = await this.oauth.getAccessToken();
    const response = await this.fetchFn(`${this.config.baseUrl}/developer/v1/cards/vault`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: this.config.cardholderUserId,
        display_name: request.displayName,
        spending_restrictions: {
          interval: 'TOTAL',
          limit: {
            amount: Math.round(request.maximumAmountUsd * 100),
            currency_code: 'USD',
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<no response body>');
      throw new Error(`Ramp card vault creation request failed with status ${response.status}: ${body}`);
    }

    // PCILimit - the card's real PAN/CVV are in body.card, never logged or
    // stored beyond the last 4 digits IssuedCard exposes. No `state` field
    // exists on this response (unlike the deferred-task shape this used to
    // assume) - a 201 with a card back is itself the only "active" signal
    // Ramp gives, so that's what's reported here.
    const body = (await response.json()) as { spend_limit_id: string; card: { id: string; pan: string } };
    return { cardId: body.card.id, last4: body.card.pan.slice(-4), state: 'ACTIVE' };
  }
}

export interface RampCliCardIssuerConfig {
  /** Command name or absolute path for the ramp-cli binary - "ramp" if it's on PATH. */
  cliBin: string;
  /** Passed as ramp's `-e` flag - which authenticated session (from `ramp auth login`) to use. */
  env: 'sandbox' | 'production';
}

/**
 * Mints a REAL Ramp Agent Card - not the Vault API card RampAgentCardIssuer
 * mints above, a genuinely different product - by shelling out to the real
 * `ramp-cli` binary's `funds creds` tool. This is the actual path to
 * `https://api.ramp.com/agent-tools`, which Ramp's own docs
 * (docs.ramp.com/developer-api/v1/build-for-ai-agents) state is "not
 * accessible to external clients" via direct REST - the CLI is what's
 * allowed to reach it, authenticated via `ramp auth login`'s interactive
 * browser OAuth session (done once, outside of anything this class does),
 * not the client-credentials pattern every other Ramp integration in this
 * project uses. That's the whole reason this class shells out to a
 * subprocess instead of making an HTTP call.
 *
 * Live-verified 2026-08-08: `ramp -e sandbox --agent funds creds <fundId>
 * --amount ... --currency_code USD --merchant_country_code ...
 * --merchant_name ... --merchant_url ... --rationale ...` returned a real
 * card (pan/cvv/expiration/billing_address/cardholder_name) against this
 * project's real sandbox account - the first successful real Agent Card
 * mint after two REST-based attempts (see docs/ramp-api-notes.md for the
 * full trail of why those couldn't work). The response has no card-id
 * field, so `cardId` here is synthesized locally - an internal reference
 * for Scrip's own receipts, not something Ramp exposes.
 */
export class RampCliCardIssuer implements CardIssuer {
  constructor(private config: RampCliCardIssuerConfig) {}

  async issueCard(request: CardIssueRequest): Promise<IssuedCard> {
    if (!request.fundId) {
      throw new Error(
        'RampCliCardIssuer requires a fundId - set ramp_fund_id on the reservation\'s budget in scrip.yaml'
      );
    }

    const args = [
      '-e',
      this.config.env,
      '--agent',
      'funds',
      'creds',
      request.fundId,
      '--amount',
      request.maximumAmountUsd.toFixed(2),
      '--currency_code',
      'USD',
      '--merchant_country_code',
      'US',
      '--merchant_name',
      request.merchant,
      '--merchant_url',
      `https://${request.merchant}`,
      '--rationale',
      `Scrip reservation: ${request.displayName}`,
    ];

    let stdout: string;
    try {
      ({ stdout } = await execFileCapturingStdout(this.config.cliBin, args));
    } catch (error) {
      // ramp-cli exits non-zero on failure but still prints a structured
      // JSON error body to stdout - Node's promisified execFile carries
      // that on the rejected error's own `.stdout` property, so surface
      // the real message instead of just "process exited with code 2".
      const stdoutFromError = (error as { stdout?: string }).stdout;
      const parsedMessage = stdoutFromError ? safeParseErrorMessage(stdoutFromError) : undefined;
      throw new Error(`ramp funds creds failed: ${parsedMessage ?? (error as Error).message}`);
    }

    const body = JSON.parse(stdout) as { data?: Array<{ pan: string }> };
    const card = body.data?.[0];
    if (!card) {
      throw new Error(`ramp funds creds returned no card data: ${stdout}`);
    }
    return { cardId: randomUUID(), last4: card.pan.slice(-4), state: 'ACTIVE' };
  }
}

function safeParseErrorMessage(rawStdout: string): string | undefined {
  try {
    const parsed = JSON.parse(rawStdout) as { error?: { message?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}

/** Local, zero-network stand-in for RampAgentCardIssuer - used when no Vault-API-enabled Ramp account is configured. Same role as MockRampGateway. */
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
