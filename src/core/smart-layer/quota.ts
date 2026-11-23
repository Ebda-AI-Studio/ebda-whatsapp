/**
 * Quota for the assistant. Free "how do I" turns: BUDGET.freeTurnsPerStorePerDay per workspace per rolling day (the journal's sliding-window counter) AND OWNER_FREE_TURNS_PER_DAY per owner across their workspaces (D1).
 * Heavy jobs (template writing, bulk) hold AI credits first and settle them on success, in the same ledger as the agent (note `assistant`); a hold whose
 * turn never settles frees itself after HOLD_TTL_MS. The assistant is the platform's, so a workspace's own model key (BYOK) never pays for or funds it.
 */
import { BUDGET } from '../../../foundation/smart-layer/plan/budget';
import type { Env } from '../../env';
import type { SmartLayerAdapter, SmartLayerStorage, TurnCtx } from '../../../foundation/smart-layer/types';

const DAY = 86_400_000;
/**
 * Free assistant turns per OWNER per rolling day, across all their workspaces (WA-OWNER-FREE-1, docs/rulings/WA-OWNER-FREE-1.md). Same number as one workspace's own allowance:
 * a second workspace of the same owner adds nothing. NEVER-stale class: it is read and written in one D1 statement, never cached.
 */
export const OWNER_FREE_TURNS_PER_DAY = BUDGET.freeTurnsPerStorePerDay;
type Credits = { assistantHold(ref: string, credits: number, now?: number): Promise<'held' | 'already_charged' | 'insufficient'>; assistantSettle(ref: string, now?: number): Promise<string> };

export const holdRef = (ctx: Pick<TurnCtx, 'conversationId' | 'now'>): string => `sl:${ctx.conversationId}:${ctx.now}`;

/** Takes one free turn from the owner's shared budget in ONE conditional statement (two workspaces of one owner cannot both read "room"). False when the budget is spent. */
async function takeOwnerTurn(env: Pick<Env, 'DB'>, storeId: string, now: number): Promise<boolean> {
  const owner = await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(storeId).first<{ owner_user_id: string }>();
  const key = owner?.owner_user_id ?? `ws:${storeId}`; // no owner row: the workspace is its own owner (never locked out, never unmetered)
  await env.DB.prepare('DELETE FROM assistant_owner_turns WHERE owner_key = ? AND at <= ?').bind(key, now - DAY).run();
  const r = await env.DB.prepare('INSERT INTO assistant_owner_turns (owner_key, at) SELECT ?1, ?2 WHERE (SELECT count(*) FROM assistant_owner_turns WHERE owner_key = ?1 AND at > ?3) < ?4')
    .bind(key, now, now - DAY, OWNER_FREE_TURNS_PER_DAY).run();
  return r.meta.changes > 0;
}

export function chatQuota(storage: Pick<SmartLayerStorage, 'bump'>, ws: Credits, env: Pick<Env, 'DB'>): SmartLayerAdapter['quota'] {
  return {
    async assertTurn(ctx, heavyCredits) {
      if ((await storage.bump(`free:${ctx.storeId}`, DAY, ctx.now)) > BUDGET.freeTurnsPerStorePerDay) throw new Error('free_cap');
      if (!(await takeOwnerTurn(env, ctx.storeId, ctx.now))) throw new Error('free_cap');
      if (heavyCredits && heavyCredits > 0 && (await ws.assistantHold(holdRef(ctx), heavyCredits, ctx.now)) === 'insufficient') throw new Error('no_credits');
    },
    async record(ctx, u) {
      if (u.heavyCredits && u.heavyCredits > 0) await ws.assistantSettle(holdRef(ctx), ctx.now);
    },
  };
}
