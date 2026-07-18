import { getModelPrice } from './pricing.js';

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
