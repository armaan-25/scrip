import fs from 'node:fs';
import path from 'node:path';

export interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export type TaskOutcomeStatus = 'success' | 'failure' | 'unknown';

export interface TaskReceipt {
  receiptId: string;
  authorizationId: string;
  rampEntityId: string;
  rampBudgetId: string;
  team: string;
  taskId: string;
  task: string;
  authorized: number;
  actual: number;
  returned: number;
  childAgents: number;
  requestCount: number;
  modelUsage: ModelUsage[];
  costCenter: string;
  startedAt: string;
  settledAt: string;
  outcome: TaskOutcomeStatus;
  outcomeEvidence?: string;
}

interface StoreData {
  receipts: TaskReceipt[];
}

export interface RampGateway {
  getReportedSpend(rampBudgetId: string, sinceMonth?: string): number;
  reportTaskUsage(receipt: TaskReceipt): void;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Local Ramp boundary used by the demo. Replace this adapter, not the lease engine. */
export class MockRampGateway implements RampGateway {
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

  reportTaskUsage(receipt: TaskReceipt): void {
    const data = this.load();
    data.receipts.push(receipt);
    this.save(data);
    console.log(
      `[ramp] budget=${receipt.rampBudgetId} task=${receipt.taskId} ` +
        `authorized=$${receipt.authorized.toFixed(4)} actual=$${receipt.actual.toFixed(4)} ` +
        `returned=$${receipt.returned.toFixed(4)}`
    );
  }

  getReportedSpend(rampBudgetId: string, sinceMonth: string = currentMonth()): number {
    return this.load().receipts
      .filter((receipt) => receipt.rampBudgetId === rampBudgetId && receipt.settledAt.startsWith(sinceMonth))
      .reduce((sum, receipt) => sum + receipt.actual, 0);
  }

  getReceipts(): TaskReceipt[] {
    return this.load().receipts;
  }
}
