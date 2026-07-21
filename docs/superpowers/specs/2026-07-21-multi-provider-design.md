# Multi-Provider Adapter Design

## Goal

Remove the single-provider limitation identified earlier: `ScripClient`
currently only knows how to call the Anthropic SDK, both for real
inference and for `ApprovalController`'s verdict calls. A company whose
stack is OpenAI-based gets zero enforcement from Scrip today. Fix that
without touching the enforcement engine at all — `TaskAuthorizationManager`
already only deals in dollars and model-name strings; it has no idea
what SDK answers a call, and shouldn't need to.

## What changes and what doesn't

**Doesn't change:** `TaskAuthorizationManager`, `BudgetRouter`,
`computeCost()`/`getModelPrice()`, `scrip.yaml`'s config shape
(`allowedModels` stays a flat string array). The enforcement layer was
already provider-agnostic; this design proves it by actually wiring a
second provider through it, not by rearchitecting it.

**Changes:** `ScripClient` and `ApprovalController` stop hard-coding the
Anthropic SDK's types and calling convention. A small provider
abstraction sits between them and the real SDKs.

## The `ModelProvider` interface

```ts
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

export interface ModelProvider {
  createMessage(params: { model: string; maxTokens: number; messages: ProviderMessage[] }): Promise<ProviderResponse>;
  renderVerdict(params: { model: string; prompt: string }): Promise<VerdictToolResult>;
}
```

Two methods only: plain inference (`createMessage`), and the
forced-structured-output call the approval controller needs
(`renderVerdict`) — each provider implements its own tool-calling
convention underneath (Anthropic's `tool_choice: {type: 'tool', name}` +
`tool_use` content blocks vs. OpenAI's `tool_choice: {type: 'function',
function: {name}}` + `tool_calls` with stringified JSON arguments). Callers
never see either SDK's shape directly.

## Which provider owns which model

`ModelPrice` (in `src/pricing/model_price.json`) gains a `provider` field:

```ts
export interface ModelPrice {
  inputPrice: number;
  outputPrice: number;
  provider: 'anthropic' | 'openai';
}
```

`scripts/port-price-table.mjs` is updated to tag every ported entry by
provider (Anthropic entries already prefixed `anthropic/` in the source
table; OpenAI entries prefixed `openai/`). `getModelPrice(model).provider`
becomes the single source of truth for routing a model name to a real
provider client — no separate config, no string-prefix guessing at the
call site.

## `ScripRuntime` / `ScripClient` wiring

```ts
export class ScripClient {
  constructor(
    private runtime: ScripRuntime,
    private providers: Record<'anthropic' | 'openai', ModelProvider>
  ) {}

  async run(options: InferenceOptions): Promise<InferenceResult> {
    // ...unchanged routing/reservation logic...
    const provider = this.providers[getModelPrice(model).provider];
    const response = await provider.createMessage({ model, maxTokens: options.maxTokens, messages: options.messages });
    // ...unchanged commit/cancel logic, now against response.inputTokens/outputTokens...
  }
}
```

Only ever the provider the chosen model actually needs is called — a task
authorized against a budget with both Anthropic and OpenAI models in
`allowedModels` can have `BudgetRouter` pick either one, and `ScripClient`
transparently calls the right SDK.

`ApprovalController` takes the same `Record<'anthropic' | 'openai',
ModelProvider>` plus the configured `controllerModel`, resolves which
provider to use via `getModelPrice(controllerModel).provider`, and calls
`provider.renderVerdict()` instead of building an Anthropic tool-use
request directly.

## Concrete providers

`src/providers/anthropic-provider.ts` — wraps `@anthropic-ai/sdk`,
implementing both methods against the real SDK (the existing
`AnthropicLike`/tool-use code from `proxy.ts`/`approval-controller.ts`
moves here largely unchanged).

`src/providers/openai-provider.ts` — wraps the `openai` npm package
(new dependency — solves "call OpenAI's chat completions API," which
nothing in this project's existing stack does; the alternative, hand-rolled
`fetch` calls against OpenAI's REST API, would mean re-implementing
request/response typing and streaming-adjacent edge cases the official
SDK already handles). Implements `createMessage` against
`chat.completions.create`, `renderVerdict` against the same endpoint with
`tools`/`tool_choice` in OpenAI's function-calling shape.

## Config addition

`scrip.yaml` gains a new `cross_provider_demo` budget rather than adding
OpenAI models into the existing `research` budget. Reason for the
correction (caught before implementation, not after): `BudgetRouter`
always prefers the *priciest* model in `allowedModels` that still fits
the remaining balance (see `src/router.ts` — it sorts `allowedModels` by
`outputPrice` descending and returns the first that fits). `research` is
the budget every existing live/demo script (`demo/run-demo.ts`,
`scripts/demo-scenario.ts`, `scripts/demo-generic-action.ts`) already
runs against with a real Anthropic client and no OpenAI client wired in.
Adding `gpt-5.6-sol` ($5.00/$30.00 per 1M tokens) — priced above
`claude-sonnet-5` — to `research.allowed_models` would make the router
silently prefer it over Claude in those already-verified demos, breaking
them the moment `OPENAI_API_KEY` isn't set (which it isn't, today).

Instead: a new `cross_provider_demo` budget, `allowed_models: [claude-sonnet-5, gpt-5.6-luna]`,
exercised only by a new `scripts/demo-cross-provider.ts` using fake
providers for both models (same deterministic, no-API-key pattern as
`scripts/demo-scenario.ts`) — proving `BudgetRouter`/`ScripClient`
genuinely dispatch to different `ModelProvider` implementations by
model name, without touching any budget an existing live demo depends on.
`gpt-5.6-luna` ($1.00/$6.00 per 1M tokens) is the real current OpenAI
budget-tier model, confirmed via `developers.openai.com/api/docs/models`.

## Testing

- `AnthropicProvider`/`OpenAIProvider`: fake HTTP/SDK clients, same
  injected-dependency pattern used everywhere else in this project.
- `ScripClient`/`ApprovalController` tests gain a second pass showing the
  exact same enforcement behavior (reservation, degrade, approval) works
  identically when the routed model resolves to the OpenAI provider
  instead of Anthropic — the point being proven is that the enforcement
  layer doesn't care which provider answered.
- No test calls a real OpenAI API — same policy as Anthropic and Ramp
  calls throughout this project; only a manual smoke test (mirroring
  `demo/run-demo.ts`) touches the real API, and only when explicitly run
  with a real `OPENAI_API_KEY`.

## Out of scope

- Gemini, other providers — the interface supports adding them the same
  way, but only Anthropic + OpenAI are built now.
- Streaming responses.
- Provider failover/fallback across providers (only within-provider
  model fallback via `onLimit: degrade` exists today).
