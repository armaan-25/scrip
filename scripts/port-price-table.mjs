import fs from 'node:fs';

const sourcePath = process.env.AGENTOPT_PRICE_PATH || `${process.env.HOME}/Desktop/Projects/agentopt/model_price.json`;
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));

const ported = {};
for (const [key, value] of Object.entries(source)) {
  const normalized = key.startsWith('anthropic/')
    ? key.slice('anthropic/'.length).replaceAll('.', '-')
    : key;
  ported[normalized] = { inputPrice: value.input_price, outputPrice: value.output_price };
}

// Demo models use exact Anthropic API model IDs, which don't match agentopt's
// OpenRouter-style slugs. Add explicit entries at the same published per-1M-token rates.
ported['claude-sonnet-5'] = { inputPrice: 3.0, outputPrice: 15.0 };
ported['claude-haiku-4-5-20251001'] = { inputPrice: 1.0, outputPrice: 5.0 };

fs.writeFileSync(
  new URL('../src/pricing/model_price.json', import.meta.url),
  JSON.stringify(ported, null, 2) + '\n'
);
console.log(`Wrote ${Object.keys(ported).length} price entries.`);
