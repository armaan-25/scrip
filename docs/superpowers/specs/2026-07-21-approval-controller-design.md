# Evidence-Based Approval Controller Design

## Goal

Build the mechanism behind `request-approval` — today `ScripClient.run()`
throws `ApprovalRequiredError` with no decision behind it whenever a
`request-approval`-configured budget can't afford a request. This directly
implements the finding from Ramp's own published research (cited earlier):
letting the same agent doing the work also decide whether to keep spending
fails badly (self-graded approval hit 97% approve regardless of framing;
self-attribution bias makes agents judge their own prior actions more
leniently). What worked in Ramp's study was a decoupled controller — a
separate model with no stake in the outcome, shown only a structured
evidence snapshot, outputting a scored, numeric-probability verdict.

## Evidence snapshot

New read-only method on `TaskAuthorizationManager`, mirroring `settleTask()`'s
aggregation without closing anything:

```ts
export interface TaskEvidenceSnapshot {
  task: string;
  allowance: number;
  spent: number;
  pending: number;
  requestCount: number;
  childAgents: number;
  elapsedSeconds: number;
  modelUsage: ModelUsage[];
  requestedShortfall: number;
}

getEvidenceSnapshot(authorizationId: string, requestedShortfall: number): TaskEvidenceSnapshot
```

Deliberately **no free-text field** for notes or recommendations — Ramp's
research found unverified advice in the prompt swings controller accuracy
from near-perfect to worse-than-random, so the evidence type itself makes
that impossible to smuggle in.

## `ApprovalController`

New file, `src/approval-controller.ts`:

```ts
export interface ControllerVerdict {
  approved: boolean;
  successProbability: number;
  reasoning: string;
}

type AnthropicLike = Pick<Anthropic, 'messages'>;

export class ApprovalController {
  constructor(private anthropic: AnthropicLike, private model: string) {}
  async evaluate(evidence: TaskEvidenceSnapshot): Promise<ControllerVerdict>
}
```

- Calls Anthropic with **forced tool use** — a `render_verdict` tool
  requiring `successProbability: number` (0–1) and `reasoning: string`.
  Forced tool choice, not free-text parsing, so the output is always
  structured and never omits the number.
- `approved = successProbability > 0.5` — mirrors Ramp's own scoring rule
  (approve ⟺ p > ½).
- The prompt presents only the evidence snapshot's fields, framed
  neutrally ("here is the current state of this task") — no narrative
  suggesting an answer, consistent with the no-free-text-evidence
  constraint above.

## `TaskAuthorizationManager.grantAdditionalAllowance()`

```ts
grantAdditionalAllowance(credential: string, amount: number): void
```

Authenticates the credential, increases both the specific lease's and the
authorization's `allowance` by `amount`. Scoped to exactly the credential
that got blocked — same pattern as every other credential-scoped method
in this class.

## Config addition

`RampBudgetConfig` gains optional `controllerModel?: string`
(`controller_model` in `scrip.yaml`). `ScripClient.run()` throws a clear
config error if `onLimit === 'request-approval'` and `controllerModel` is
unset — no silent fallback to a default model. The `escalation` budget in
`scrip.yaml` (the only one currently using `request-approval`) sets
`controller_model: claude-sonnet-5`.

## `ScripClient` changes

Owns an in-memory `Map<authorizationId, ControllerVerdict>` — **one
verdict per task, ever**. First blocked request on a `request-approval`
budget triggers the controller; the verdict is cached. A later request in
the same task that also can't fit auto-denies without re-invoking the
controller — prevents both runaway controller-call cost and a task
"re-asking" until it gets a yes, which would undermine the whole point of
a decoupled judge.

On the `request-approval` branch, after `reserveRequest()` throws:

1. Check the cache for this `authorizationId`. If a verdict already
   exists, act on it directly (no new controller call).
2. If none: build the evidence snapshot via `getEvidenceSnapshot()`, call
   `ApprovalController.evaluate()`, cache the verdict.
3. If approved: `grantAdditionalAllowance(credential, shortfall)`, retry
   `reserveRequest()` once (mirrors the `degrade` retry-once pattern).
4. If denied: throw `ApprovalRequiredError`.

The controller's own Anthropic call cost is **not** charged to the task's
lease/authorization — it's an external check, not part of the task's own
work, and charging it to the same budget it's gatekeeping would be
circular. For this design, that cost is simply not tracked against any
budget (logged via `console.log`, no enforcement) — a future design could
introduce a dedicated overhead budget if this needs hardening.

## Testing

- `getEvidenceSnapshot()`: correct aggregation of usage events, child
  count, elapsed time, without mutating or closing the authorization.
- `ApprovalController`: forced tool use parsing, `approved` threshold at
  exactly 0.5, against a fake Anthropic client.
- `grantAdditionalAllowance()`: increases both lease and authorization
  allowance by exactly the requested amount, scoped to the right lease.
- `ScripClient` integration: controller invoked once and cached (a second
  blocked request in the same task doesn't re-invoke it); approval grants
  exactly the shortfall and the retried call succeeds; denial throws
  `ApprovalRequiredError`; missing `controllerModel` config throws a clear
  error before any Anthropic call.

## Out of scope

- Enforcement of a separate overhead budget for controller calls (logged
  only, for now).
- Any UI or notification for a pending/denied approval.
- Re-evaluating a denied verdict under new evidence — denial is final for
  the task's lifetime by design.
