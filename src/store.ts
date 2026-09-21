import fs from 'node:fs';
import path from 'node:path';

export interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * inference = a model call; paid_api/purchase = any other reserved economic
 * action; cloud_compute/human_approval = declared by the pivot's
 * EconomicActionType but not yet exercised by any real caller in this repo
 * (no compute or approval-overhead action is reserved anywhere today - these
 * exist so the type is forward-compatible, not because they're implemented);
 * other = uncategorized.
 */
export type ActionType = 'inference' | 'paid_api' | 'purchase' | 'cloud_compute' | 'human_approval' | 'other';

export interface ActionUsage {
  actionType: ActionType;
  count: number;
  cost: number;
}

// 'partial' is declared per the pivot's outcome model but nothing in this
// repo produces it yet - settleTask() only ever passes through what its
// caller supplies, and no caller currently emits 'partial'.
export type TaskOutcomeStatus = 'success' | 'failure' | 'partial' | 'unknown';

/**
 * Structured evidence for OutcomeVerifier implementations (src/outcome-verifier.ts)
 * to attach to a settled receipt - e.g. "PR #418 merged," "CI run 9182 passed."
 * Distinct from the free-text `outcomeEvidence` string field below, which is
 * the CLI/manual path (`scrip settle <id> --evidence "text"`) and predates
 * this. Both are populated independently; neither replaces the other.
 */
export interface OutcomeEvidence {
  type: string;
  description: string;
  verifiedAt: string;
  data?: Record<string, unknown>;
}

/** Per-action-type cost breakdown, derived from actionUsage - the pivot's `costs` block on TaskReceipt. */
export interface CostBreakdown {
  inferenceUsd: number;
  paidApiUsd: number;
  cloudComputeUsd: number;
  purchasesUsd: number;
  approvalOverheadUsd: number;
  otherUsd: number;
}

export interface TaskReceipt {
  receiptId: string;
  authorizationId: string;
  entityId: string;
  budgetId: string;
  team: string;
  taskId: string;
  task: string;
  authorized: number;
  actual: number;
  returned: number;
  /** @deprecated use workerCount - kept for existing callers, identical value. */
  childAgents: number;
  /** Non-root leases settled under this task - the pivot's `workerCount`. */
  workerCount: number;
  /** @deprecated use actionCount - kept for existing callers, identical value. */
  requestCount: number;
  /** Every committed action regardless of type - the pivot's `actionCount`. */
  actionCount: number;
  modelUsage: ModelUsage[];
  actionUsage: ActionUsage[];
  /** Derived from actionUsage - see CostBreakdown. */
  costs: CostBreakdown;
  costCenter: string;
  startedAt: string;
  settledAt: string;
  outcome: TaskOutcomeStatus;
  outcomeEvidence?: string;
  /** Structured evidence from an OutcomeVerifier, if one ran. See OutcomeEvidence. */
  evidenceDetail?: OutcomeEvidence[];
}

interface StoreData {
  receipts: TaskReceipt[];
}

export interface FinanceGateway {
  getReportedSpend(budgetId: string, sinceMonth?: string): Promise<number>;
  reportTaskUsage(receipt: TaskReceipt): Promise<void>;
  /** The settled receipt for a task, if it's been reported through this gateway. Used by `scrip receipt show/export`. */
  getReceipt(authorizationId: string): Promise<TaskReceipt | undefined>;
}

/**
 * Alias toward the pivot's proposed name for this boundary - "Scrip should
 * integrate with Ramp through adapters, not recreate Ramp." FinanceGateway's
 * two methods (read policy, report settled usage) are already exactly that
 * shape; this alias exists so new code can use the vendor-neutral name
 * without a breaking rename of every existing FinanceGateway implementation.
 */
export type FinanceControlPlane = FinanceGateway;

/** Rolls ActionUsage[] into the named CostBreakdown buckets on TaskReceipt. */
export function computeCostBreakdown(actionUsage: ActionUsage[]): CostBreakdown {
  const byType = Object.fromEntries(actionUsage.map((u) => [u.actionType, u.cost])) as Partial<
    Record<ActionType, number>
  >;
  return {
    inferenceUsd: byType.inference ?? 0,
    paidApiUsd: byType.paid_api ?? 0,
    cloudComputeUsd: byType.cloud_compute ?? 0,
    purchasesUsd: byType.purchase ?? 0,
    approvalOverheadUsd: byType.human_approval ?? 0,
    otherUsd: byType.other ?? 0,
  };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Local JSON-file receipt persistence, shared by every FinanceGateway implementation. */
export class LocalReceiptStore {
  constructor(private filePath: string) {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.save({ receipts: [] });
    }
  }

  private load(): StoreData {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  private save(data: StoreData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n');
  }

  addReceipt(receipt: TaskReceipt): void {
    const data = this.load();
    data.receipts.push(receipt);
    this.save(data);
    console.log(
      `[scrip] budget=${receipt.budgetId} task=${receipt.taskId} ` +
        `authorized=$${receipt.authorized.toFixed(4)} actual=$${receipt.actual.toFixed(4)} ` +
        `returned=$${receipt.returned.toFixed(4)}`
    );
  }

  getSpend(budgetId: string, sinceMonth: string = currentMonth()): number {
    return this.load().receipts
      .filter((receipt) => receipt.budgetId === budgetId && receipt.settledAt.startsWith(sinceMonth))
      .reduce((sum, receipt) => sum + receipt.actual, 0);
  }

  getReceipts(): TaskReceipt[] {
    return this.load().receipts;
  }

  getReceipt(authorizationId: string): TaskReceipt | undefined {
    return this.load().receipts.find((receipt) => receipt.authorizationId === authorizationId);
  }
}

/** One settled lease's outcome, as recorded against its agentId - the unit AgentTrackRecordStore aggregates. */
export interface LeaseSettlement {
  agentId: string;
  leaseId: string;
  authorizationId: string;
  outcome: TaskOutcomeStatus;
  settledAt: string;
}

interface TrackRecordData {
  settlements: LeaseSettlement[];
}

export interface ResolveRate {
  agentId: string;
  resolved: number;
  total: number;
  rate: number;
}

/**
 * Per-agentId settlement history, independent of TaskReceipt (which records
 * one outcome per root task, not per delegated agent - see settleLease() in
 * lease.ts for where these entries come from). Same local JSON-file pattern
 * as LocalReceiptStore, and deliberately a separate file: receipts are
 * externally reported financial records, this is Scrip's own trust signal.
 */
export class AgentTrackRecordStore {
  constructor(private filePath: string) {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.save({ settlements: [] });
    }
  }

  private load(): TrackRecordData {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  private save(data: TrackRecordData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n');
  }

  addSettlement(settlement: LeaseSettlement): void {
    const data = this.load();
    data.settlements.push(settlement);
    this.save(data);
  }

  /** success/partial count as resolved; failure/unknown don't - mirrors settleTask()'s TaskOutcomeStatus values. */
  getResolveRate(agentId: string): ResolveRate {
    const settlements = this.load().settlements.filter((s) => s.agentId === agentId);
    const resolved = settlements.filter((s) => s.outcome === 'success' || s.outcome === 'partial').length;
    return {
      agentId,
      resolved,
      total: settlements.length,
      rate: settlements.length === 0 ? 1 : resolved / settlements.length,
    };
  }
}

/** Local JSON-file finance boundary. Replace this adapter, not the lease engine. */
export class LocalFinanceGateway implements FinanceGateway {
  private readonly store: LocalReceiptStore;

  constructor(filePath: string) {
    this.store = new LocalReceiptStore(filePath);
  }

  async reportTaskUsage(receipt: TaskReceipt): Promise<void> {
    this.store.addReceipt(receipt);
  }

  async getReportedSpend(budgetId: string, sinceMonth?: string): Promise<number> {
    return this.store.getSpend(budgetId, sinceMonth);
  }

  async getReceipt(authorizationId: string): Promise<TaskReceipt | undefined> {
    return this.store.getReceipt(authorizationId);
  }

  getReceipts(): TaskReceipt[] {
    return this.store.getReceipts();
  }
}
