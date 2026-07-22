import type { OutcomeEvidence } from './store.js';

/**
 * Provider-neutral outcome verification. The pivot's stated principle:
 * "Do not ask an LLM to declare success based only on the worker's own
 * narrative" - deterministic evidence (a merged PR, a passed CI run) is
 * preferred over self-reported success wherever it's available. The
 * approval controller (src/approval-controller.ts) is a distinct concept -
 * it judges *mid-task continuation*, not *final outcome* - and stays
 * available for exceptions where no deterministic verifier applies.
 */
export interface OutcomeVerifier<Request = unknown> {
  readonly type: string;
  verify(request: Request): Promise<OutcomeEvidence>;
}
