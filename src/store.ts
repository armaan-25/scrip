import fs from 'node:fs';
import path from 'node:path';

export interface Receipt {
  team: string;
  project: string;
  feature: string;
  task: string;
  authorized: number;
  actual: number;
  model: string;
  costCenter: string;
  timestamp: string;
}

interface StoreData {
  receipts: Receipt[];
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

export class MockRampStore {
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

  addReceipt(receipt: Receipt): void {
    const data = this.load();
    data.receipts.push(receipt);
    this.save(data);
    console.log(
      `[receipt] team=${receipt.team} project=${receipt.project} feature=${receipt.feature} ` +
        `task="${receipt.task}" authorized=$${receipt.authorized.toFixed(4)} actual=$${receipt.actual.toFixed(4)} ` +
        `model=${receipt.model} costCenter=${receipt.costCenter}`
    );
  }

  getSpend(project: string, feature: string, sinceMonth: string = currentMonth()): number {
    const data = this.load();
    return data.receipts
      .filter((r) => r.project === project && r.feature === feature && r.timestamp.startsWith(sinceMonth))
      .reduce((sum, r) => sum + r.actual, 0);
  }
}
