import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ModelPrice {
  inputPrice: number; // dollars per 1,000,000 input tokens
  outputPrice: number; // dollars per 1,000,000 output tokens
  // 'other' covers the many non-Anthropic/non-OpenAI entries ported from
  // agentopt's reference table (Gemini, Qwen, etc.) that Scrip doesn't
  // have a ModelProvider for - out of scope per the multi-provider design.
  provider: 'anthropic' | 'openai' | 'other';
}

const priceTable: Record<string, ModelPrice> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'pricing', 'model_price.json'), 'utf-8')
);

export function getModelPrice(model: string): ModelPrice {
  const price = priceTable[model];
  if (!price) {
    throw new Error(`No price entry for model "${model}"`);
  }
  return price;
}

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = getModelPrice(model);
  return (inputTokens / 1_000_000) * price.inputPrice + (outputTokens / 1_000_000) * price.outputPrice;
}
