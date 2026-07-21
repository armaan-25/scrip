export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface VerdictToolResult {
  successProbability: number;
  reasoning: string;
}

/**
 * Unifies the Anthropic and OpenAI SDKs behind two calls: plain inference
 * and a forced-structured-output verdict. Each provider implements its own
 * tool-calling convention underneath; callers never see either SDK's shape.
 */
export interface ModelProvider {
  createMessage(params: { model: string; maxTokens: number; messages: ProviderMessage[] }): Promise<ProviderResponse>;
  renderVerdict(params: { model: string; prompt: string }): Promise<VerdictToolResult>;
}

export type ProviderName = 'anthropic' | 'openai';
