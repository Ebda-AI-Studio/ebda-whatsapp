/** Planning rail 6: per-turn budgets and per-user rate (plan 4 Task A7, spec 6.9). Numbers are fixed in v1. */
import type { SmartLayerStorage, TurnCtx } from '../types';

export const BUDGET = { toolsOffered: 15, toolCalls: 6, modelCalls: 7, outputTokens: 700, inputChars: 2000, turnsPerConversation: 40, turnsPerUserPerMinute: 10, freeTurnsPerStorePerDay: 150 } as const;
export type BudgetKey = keyof typeof BUDGET;

export class BudgetExceeded extends Error {
  constructor(readonly which: 'toolCalls' | 'modelCalls') {
    super(`budget exceeded: ${which}`);
    this.name = 'BudgetExceeded';
  }
}

export class TurnBudget {
  private readonly cap: Record<BudgetKey, number>;
  private tools = 0;
  private models = 0;
  constructor(b: Partial<Record<BudgetKey, number>> = {}) {
    this.cap = { ...BUDGET, ...b };
  }
  spendModel(): void {
    if (this.models >= this.cap.modelCalls) throw new BudgetExceeded('modelCalls');
    this.models++;
  }
  spendTool(): void {
    if (this.tools >= this.cap.toolCalls) throw new BudgetExceeded('toolCalls');
    this.tools++;
  }
  get modelCalls(): number { return this.models; }
  get maxOutputTokens(): number { return this.cap.outputTokens; }
}

const WEEK = 7 * 24 * 3600 * 1000;
/** Counts this turn against the user's minute and the conversation; both counters are bumped on every call (a refused turn still counts). */
export async function checkRate(storage: Pick<SmartLayerStorage, 'bump'>, ctx: TurnCtx): Promise<'ok' | 'user_rate' | 'conversation_full'> {
  const perMinute = await storage.bump(`sl:rate:${ctx.product}:${ctx.storeId}:${ctx.userId}`, 60_000, ctx.now);
  const perConversation = await storage.bump(`sl:conv:${ctx.product}:${ctx.storeId}:${ctx.conversationId}`, WEEK, ctx.now);
  if (perMinute > BUDGET.turnsPerUserPerMinute) return 'user_rate';
  if (perConversation > BUDGET.turnsPerConversation) return 'conversation_full';
  return 'ok';
}
