import { getModelPrice } from './pricing.js';

/**
 * Deliberately small fallback selection helper - not the product's wedge.
 * Decided during the execution-economics pivot (docs/PIVOT_AUDIT.md §8.2):
 * kept as-is rather than deleted or moved behind a formal adapter, because
 * inspecting its real dependents (ScripClient.run() when no explicit model
 * is given, plus tests/router.test.ts) found no product-marketing framing
 * anywhere in committed docs calling it a differentiator - that concern
 * only ever applied to how it could be talked about, not to this ~20-line
 * class. The rule going forward: don't write README/positioning copy that
 * calls model routing Scrip's wedge; the wedge is transactional cost
 * isolation + outcome-backed settlement (see README.md).
 */
export interface RouteContext {
  remainingBudget: number;
  taskEstimate: number;
  allowedModels: string[];
  fallbackModel: string;
}

export class BudgetRouter {
  route(ctx: RouteContext): string {
    const fallbackPrice = getModelPrice(ctx.fallbackModel).outputPrice;
    const byPriceDesc = [...ctx.allowedModels].sort(
      (a, b) => getModelPrice(b).outputPrice - getModelPrice(a).outputPrice
    );
    for (const model of byPriceDesc) {
      const scaledEstimate = ctx.taskEstimate * (getModelPrice(model).outputPrice / fallbackPrice);
      if (scaledEstimate <= ctx.remainingBudget) return model;
    }
    return ctx.fallbackModel;
  }
}
