# SpendSpec

Gives every AI call a team/project/feature identity, a visible budget policy,
and runtime-enforced spending limits before it runs.

## Setup

```bash
npm install
node scripts/port-price-table.mjs   # regenerate src/pricing/model_price.json if needed
export ANTHROPIC_API_KEY=sk-...
```

## Run the tests

```bash
npm test
```

## Run the MCP server

```bash
npm run mcp-server
```

Exposes 4 tools over stdio: `get_spend_policy`, `estimate_spend`,
`request_more_budget`, `record_usage`. Point a Claude Code MCP client
config at `bin/mcp-server.ts` (run via `tsx`) to call these tools live.

## Run the demo

```bash
npm run demo
```

Makes real, billed Anthropic API calls against the `research-agent` project
in `spendspec.yaml` ($2/month demo budget) and prints the before/after cost
comparison plus final receipts.
