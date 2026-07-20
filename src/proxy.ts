import type Anthropic from '@anthropic-ai/sdk';
import { ApprovalRequiredError, SpendLimitExceededError, type RequestReservation } from './lease.js';
import { computeCost } from './pricing.js';
import type { ScripRuntime } from './runtime.js';

export interface InferenceOptions {
  credential: string;
  model?: string;
  estimatedInputTokens: number;
  maxTokens: number;
  messages: Anthropic.MessageParam[];
}

export interface InferenceResult {
  model: string;
  actualCost: number;
  message: Anthropic.Message;
}

type AnthropicLike = Pick<Anthropic, 'messages'>;

/** Provider proxy: every request is preauthorized against the task credential before network I/O. */
export class ScripClient {
  constructor(private runtime: ScripRuntime, private anthropic: AnthropicLike) {}

  async run(options: InferenceOptions): Promise<InferenceResult> {
    const authorization = this.runtime.authorizations.getAuthorizationForCredential(options.credential);
    const budget = this.runtime.getBudget(authorization.budgetName);
    const remaining = authorization.allowance - authorization.spent - authorization.pending;
    // A caller estimate alone is not a security boundary. UTF-8 bytes are a
    // deliberately conservative local ceiling for message tokens, with room
    // for provider-added message framing.
    const inputTokenCeiling = Math.max(
      options.estimatedInputTokens,
      Buffer.byteLength(JSON.stringify(options.messages), 'utf8') + 256
    );
    const fallbackEstimate = computeCost(
      budget.fallbackModel,
      inputTokenCeiling,
      options.maxTokens
    );
    let model =
      options.model ??
      this.runtime.router.route({
        remainingBudget: remaining,
        taskEstimate: fallbackEstimate,
        allowedModels: budget.allowedModels,
        fallbackModel: budget.fallbackModel,
      });

    // max_tokens gives us a deterministic output ceiling. Reserving the full
    // possible cost prevents concurrent agents from oversubscribing the task.
    let maximumCost = computeCost(model, inputTokenCeiling, options.maxTokens);
    let reservation: RequestReservation;
    try {
      reservation = this.runtime.authorizations.reserveRequest(options.credential, model, maximumCost);
    } catch (error) {
      if (!(error instanceof SpendLimitExceededError)) throw error;

      if (budget.onLimit === 'degrade' && model !== budget.fallbackModel) {
        // One degrade retry only: fall back to the configured cheaper model
        // and try once more. If that still doesn't fit, let it throw.
        model = budget.fallbackModel;
        maximumCost = computeCost(model, inputTokenCeiling, options.maxTokens);
        reservation = this.runtime.authorizations.reserveRequest(options.credential, model, maximumCost);
      } else if (budget.onLimit === 'request-approval') {
        // No approval-callback mechanism exists yet; this just makes the
        // failure mode distinguishable from a flat deny for callers that
        // want to build one.
        throw new ApprovalRequiredError(error.message);
      } else {
        throw error;
      }
    }

    try {
      const message = (await this.anthropic.messages.create({
        model,
        max_tokens: options.maxTokens,
        messages: options.messages,
      })) as Anthropic.Message;
      const actualCost = computeCost(model, message.usage.input_tokens, message.usage.output_tokens);
      this.runtime.authorizations.commitRequest(
        reservation.reservationId,
        message.usage.input_tokens,
        message.usage.output_tokens,
        actualCost
      );
      return { model, actualCost, message };
    } catch (error) {
      try {
        this.runtime.authorizations.cancelRequest(reservation.reservationId);
      } catch {
        // commitRequest already consumes the reservation when provider usage
        // violates the preauthorized ceiling.
      }
      throw error;
    }
  }
}
