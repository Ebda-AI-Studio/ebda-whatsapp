/**
 * Quota for the assistant. Free "how do I" turns: BUDGET.freeTurnsPerStorePerDay per workspace per rolling day (the journal's sliding-window counter).
 * Heavy jobs (template writing, bulk) hold AI credits first and settle them on success, in the same ledger as the agent (note `assistant`); a hold whose
 * turn never settles frees itself after HOLD_TTL_MS. The assistant is the platform's, so a workspace's own model key (BYOK) never pays for or funds it.
 */
import { BUDGET } from '../../../foundation/smart-layer/plan/budget';
import type { SmartLayerAdapter, SmartLayerStorage, TurnCtx } from '../../../foundation/smart-layer/types';

const DAY = 86_400_000;
type Credits = { assistantHold(ref: string, credits: number, now?: number): Promise<'held' | 'already_charged' | 'insufficient'>; assistantSettle(ref: string, now?: number): Promise<string> };

export const holdRef = (ctx: Pick<TurnCtx, 'conversationId' | 'now'>): string => `sl:${ctx.conversationId}:${ctx.now}`;

export function chatQuota(storage: Pick<SmartLayerStorage, 'bump'>, ws: Credits): SmartLayerAdapter['quota'] {
  return {
    async assertTurn(ctx, heavyCredits) {
      if ((await storage.bump(`free:${ctx.storeId}`, DAY, ctx.now)) > BUDGET.freeTurnsPerStorePerDay) throw new Error('free_cap');
      if (heavyCredits && heavyCredits > 0 && (await ws.assistantHold(holdRef(ctx), heavyCredits, ctx.now)) === 'insufficient') throw new Error('no_credits');
    },
    async record(ctx, u) {
      if (u.heavyCredits && u.heavyCredits > 0) await ws.assistantSettle(holdRef(ctx), ctx.now);
    },
  };
}
