/**
 * Receipt shape and finance boundary for the task ledger in lease.ts. The
 * ledger reads reported spend and writes settled receipts through
 * FinanceGateway; the only live implementation is the SQLite-backed one in
 * PurchaseMissionService.manager().
 */

/** purchase = a merchant purchase; paid_api = a metered call; other = uncategorized. */
export type ActionType = 'purchase' | 'paid_api' | 'other';

export interface ActionUsage {
  actionType: ActionType;
  count: number;
  cost: number;
}

// 'partial' is reserved for multi-item outcomes; no caller emits it yet.
export type TaskOutcomeStatus = 'success' | 'failure' | 'partial' | 'unknown';

/**
 * Structured evidence attached to a settled receipt (e.g. a merchant's booking
 * confirmation). Distinct from the free-text `outcomeEvidence` summary.
 */
export interface OutcomeEvidence {
  type: string;
  description: string;
  verifiedAt: string;
  data?: Record<string, unknown>;
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
  /** Non-root leases under this task. */
  workerCount: number;
  /** Committed actions of any type. */
  actionCount: number;
  actionUsage: ActionUsage[];
  costCenter: string;
  startedAt: string;
  settledAt: string;
  outcome: TaskOutcomeStatus;
  outcomeEvidence?: string;
  evidenceDetail?: OutcomeEvidence[];
}

/** Where the ledger reads month-to-date spend and reports settled receipts. Replace this adapter, not the ledger. */
export interface FinanceGateway {
  getReportedSpend(budgetId: string): Promise<number>;
  reportTaskUsage(receipt: TaskReceipt): Promise<void>;
}
