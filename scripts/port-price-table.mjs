import fs from 'node:fs';

const sourcePath = process.env.AGENTOPT_PRICE_PATH || `${process.env.HOME}/Desktop/Projects/agentopt/model_price.json`;
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));

function providerOf(key) {
  if (key.startsWith('anthropic/') || key.startsWith('claude-')) return 'anthropic';
  if (key.startsWith('openai/') || key.startsWith('gpt-')) return 'openai';
  return 'other';
}

const ported = {};
for (const [key, value] of Object.entries(source)) {
  const normalized = key.startsWith('anthropic/')
    ? key.slice('anthropic/'.length).replaceAll('.', '-')
    : key;
  ported[normalized] = { inputPrice: value.input_price, outputPrice: value.output_price, provider: providerOf(normalized) };
}

// Demo models use exact Anthropic/OpenAI API model IDs, which don't match
// agentopt's OpenRouter-style slugs. Add explicit entries at the same
// published per-1M-token rates - all confirmed real, not guessed (see
// docs/superpowers/specs/2026-07-21-multi-provider-design.md).
ported['claude-sonnet-5'] = { inputPrice: 3.0, outputPrice: 15.0, provider: 'anthropic' };
ported['claude-haiku-4-5-20251001'] = { inputPrice: 1.0, outputPrice: 5.0, provider: 'anthropic' };
ported['gpt-5.6-sol'] = { inputPrice: 5.0, outputPrice: 30.0, provider: 'openai' };
ported['gpt-5.6-terra'] = { inputPrice: 2.5, outputPrice: 15.0, provider: 'openai' };
ported['gpt-5.6-luna'] = { inputPrice: 1.0, outputPrice: 6.0, provider: 'openai' };

fs.writeFileSync(
  new URL('../src/pricing/model_price.json', import.meta.url),
  JSON.stringify(ported, null, 2) + '\n'
);
console.log(`Wrote ${Object.keys(ported).length} price entries.`);
