import { getModelPrice } from './pricing.js';

export interface RouteContext {
  remainingBudget: number;
  taskEstimate: number;
  allowedModels: string[];
  fallbackModel: string;
}

export class BudgetRouter {
  route(ctx: RouteContext): string {
    const { remainingBudget, taskEstimate, allowedModels, fallbackModel } = ctx;
    const fallbackPrice = getModelPrice(fallbackModel).outputPrice;

    const byPriceDesc = [...allowedModels].sort(
      (a, b) => getModelPrice(b).outputPrice - getModelPrice(a).outputPrice
    );

    for (const model of byPriceDesc) {
      const modelPrice = getModelPrice(model).outputPrice;
      const scaledEstimate = taskEstimate * (modelPrice / fallbackPrice);
      if (scaledEstimate <= remainingBudget) {
        return model;
      }
    }
    return fallbackModel;
  }
}
