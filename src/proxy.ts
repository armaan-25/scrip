import type Anthropic from '@anthropic-ai/sdk';
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
    const model =
      options.model ??
      this.runtime.router.route({
        remainingBudget: remaining,
        taskEstimate: fallbackEstimate,
        allowedModels: budget.allowedModels,
        fallbackModel: budget.fallbackModel,
      });

    // max_tokens gives us a deterministic output ceiling. Reserving the full
    // possible cost prevents concurrent agents from oversubscribing the task.
    const maximumCost = computeCost(model, inputTokenCeiling, options.maxTokens);
    const reservation = this.runtime.authorizations.reserveRequest(options.credential, model, maximumCost);

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
