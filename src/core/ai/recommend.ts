/**
 * `recommend_products`: the agent suggests products from THIS store's catalogue (similar items, complements, "you might also like" after an order,
 * a budget or an occasion). It is a thin layer over three things that already exist and are not forked here:
 *  - the Store's recommendation engine, reached through the bridge `getRecommendations` (Ruling CHAT-RECS-1: active, public, in stock, priced by the Store);
 *  - the Store search (`search_catalog`'s path) for budget / occasion asks that have no seed product;
 *  - `show_products` for the cards (live re-read of price and stock, the synced-catalogue ledger, one product message per turn).
 * The model names a product by the retailer id it saw in a tool result, an order number the customer wrote, or free words; it never names a store,
 * a phone number or a price. Suggestions are rationed per customer so a chatty agent cannot spam (see `RECS_PER_DAY`).
 */
import { z } from 'zod';
import { buyerKey } from '../buyer-key';
import { isE164 } from '../phone';
import { storeLink } from '../store-link';
import { MAX_RETAILER_ID, type CatalogRow, type RecommendationRequest } from '../store-bridge';
import { getAgentState, putAgentState } from './settings';
import type { ToolDef } from './provider';
import type { ToolContext } from './tools';

/** The Store's own cap on a budget ceiling (maxPriceMinor 100_000_000 = 1,000,000 in major units); the same cap as `search_catalog`. */
export const MAX_BUDGET = 1_000_000;
/** Recommendation sets (one tool call that found something) one customer may be sent in 24 h. The fourth is refused until the oldest ages out. */
export const RECS_PER_DAY = 3;
/** Products one set may carry. */
export const RECS_PER_SET = 4;
const DAY_MS = 86_400_000;
const keyOf = (messageId: number) => `recs:${messageId}`;

export const recommendArgs = z.object({
  basis: z.enum(['similar', 'complement', 'after_order', 'budget']),
  /** The `id` of a product from a search result: similar / complement are relative to it. */
  productId: z.string().trim().min(1).max(MAX_RETAILER_ID).optional(),
  orderNumber: z.string().trim().regex(/^[\w-]{1,40}$/).optional(),
  /** Budget ceiling in the store's currency (major units, as the customer says it). */
  maxPrice: z.number().positive().max(MAX_BUDGET).optional(),
  /** budget / occasion: what the customer wants, in their words. */
  query: z.string().trim().min(1).max(120).optional(),
});
export type RecommendArgs = z.infer<typeof recommendArgs>;

/** What `tools.ts` lends this module (it owns them; passing them in keeps the import graph acyclic). */
export type RecommendDeps = {
  show: (ctx: ToolContext, ids: string[]) => Promise<unknown>;
  search: (ctx: ToolContext, query: string) => Promise<{ results: { id: string; price: number; inStock: boolean }[] } | { error: string }>;
};

type Window = { count: number; shown: Set<string> };

/** Sets this customer was sent in the last 24 h (other turns only: a replayed turn must not count itself) and what they already saw. */
function windowOf(ctx: ToolContext, now: number): Window {
  const rows = ctx.host.sql.exec<{ value: string }>(
    `SELECT a.value FROM agent_state a JOIN messages m ON a.key = 'recs:' || m.id JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
     WHERE ct.wa_id = ? AND a.key != ? AND json_extract(a.value, '$.at') > ?`,
    ctx.from, keyOf(ctx.messageId), now - DAY_MS,
  ).toArray();
  const shown = new Set<string>();
  for (const r of rows) for (const id of (JSON.parse(r.value) as { ids: string[] }).ids) shown.add(id);
  return { count: rows.length, shown };
}

const toHit = (r: CatalogRow) => ({ id: r.retailerId, name: r.title, nameAr: r.titleAr, price: r.priceMinor / 100, currency: r.currency, inStock: r.availability === 'in_stock', link: r.link });

/**
 * The daily ration is claimed ATOMICALLY: the count and the reservation row are one synchronous step inside the workspace Durable Object (no await between
 * the read and the write), so two turns of the same customer running at once cannot both pass with one slot left. The reservation is released on every
 * path that sends nothing, and replaced by the real set when something is sent.
 */
export async function recommendProducts(ctx: ToolContext, a: RecommendArgs, deps: RecommendDeps, now = Date.now()): Promise<unknown> {
  if (ctx.recommended) return { error: 'already_recommended_this_turn', note: 'Cards for this turn were already sent: write your one short sentence now. If the customer asked for something different, use search_catalog and show_products.' };
  const win = windowOf(ctx, now);
  if (win.count >= RECS_PER_DAY) return { error: 'rate_limited', note: 'Enough suggestions were sent already today: do not call recommend_products again. If the customer ASKED for products, ideas, a gift or gave a budget, do not stop here: in this same turn call search_catalog (with the same maxPrice when they gave one) and then show_products. Only when nothing was asked (a suggestion of your own) answer in plain words and suggest nothing more.' };
  // A retried turn reuses its message id: keep what it already sent so a failed retry restores it instead of erasing it from the daily count.
  const previous = getAgentState(ctx.host.sql, keyOf(ctx.messageId));
  putAgentState(ctx.host.sql, keyOf(ctx.messageId), JSON.stringify({ at: now, ids: [] }));
  let sent = false;
  try {
    const out = await recommendOnce(ctx, a, deps, win, now);
    sent = Boolean((ctx as ToolContext).recommended); // set by recommendOnce once cards went out (TS narrows the early return above)
    return out;
  } finally {
    if (!sent) {
      if (previous === null) ctx.host.sql.exec('DELETE FROM agent_state WHERE key = ?', keyOf(ctx.messageId));
      else putAgentState(ctx.host.sql, keyOf(ctx.messageId), previous);
    }
  }
}

async function recommendOnce(ctx: ToolContext, a: RecommendArgs, deps: RecommendDeps, win: Window, now: number): Promise<unknown> {
  const bridge = ctx.bridge!;

  const maxPriceMinor = a.maxPrice !== undefined ? Math.round(a.maxPrice * 100) : undefined;
  let candidates: string[];
  if (a.basis === 'budget') {
    if (!a.query) return { error: 'invalid_arguments' };
    const found = await deps.search(ctx, a.query);
    if ('error' in found) return { error: 'store_unavailable' };
    candidates = found.results.filter((h) => h.inStock && (a.maxPrice === undefined || h.price <= a.maxPrice)).map((h) => h.id);
  } else {
    const req: RecommendationRequest = { seedIds: [], mode: a.basis === 'similar' ? 'similar' : 'complement', limit: 8, ...(maxPriceMinor !== undefined ? { maxPriceMinor } : {}) };
    if (a.basis === 'after_order') {
      const secret = storeLink().buyerSecret(ctx.host.env);
      const e164 = `+${ctx.from}`;
      if (!secret || !isE164(e164)) return { error: 'unavailable' };
      const key = await buyerKey(secret, e164);
      let orderNumber = a.orderNumber;
      if (!orderNumber) {
        const latest = await bridge.listCustomerOrders(ctx.host.workspaceId, key, 1);
        if (!latest.ok) return { error: latest.reason === 'invalid' ? 'invalid_arguments' : 'store_unavailable' };
        orderNumber = latest.value.items[0]?.orderNumber;
        if (!orderNumber) return { error: 'no_order' };
      }
      Object.assign(req, { orderNumber, buyerKey: key, phoneE164: e164 });
    } else {
      if (!a.productId) return { error: 'invalid_arguments' };
      req.seedIds = [a.productId];
    }
    const res = await bridge.getRecommendations(ctx.host.workspaceId, req);
    // `invalid` is the Store refusing the request (a bad budget, seed or buyer proof): a fixed code, never the Store's message. Only a real outage is `store_unavailable`.
    if (!res.ok) return { error: res.reason === 'not_found' ? 'not_found' : res.reason === 'invalid' ? 'invalid_arguments' : 'store_unavailable' };
    // The engine's answer is re-checked here too: in stock, inside the budget, not the seed, not already suggested to this customer.
    candidates = res.value.items.filter((r) => r.availability === 'in_stock' && (maxPriceMinor === undefined || r.priceMinor <= maxPriceMinor) && r.retailerId !== a.productId).map((r) => r.retailerId);
  }
  const ids = [...new Set(candidates)].filter((id) => !win.shown.has(id)).slice(0, RECS_PER_SET);
  if (!ids.length) return { error: 'nothing_to_recommend', note: 'Do not invent products. If the customer ASKED for products, ideas, a gift or gave a budget, do not stop here: in this same turn call search_catalog (with the same maxPrice when they gave one) and then show_products. Only if that finds nothing too, say so plainly.' };

  // Cards (or text hits) read live from the Store: the price and stock the customer sees are never the engine's or the model's.
  const shown = await deps.show(ctx, ids) as { products?: { id: string }[]; without_card?: { id: string }[]; error?: string };
  if (shown.error) return shown;
  ctx.recommended = true;
  const offered = [...(shown.products ?? []), ...(shown.without_card ?? [])].map((p) => p.id);
  putAgentState(ctx.host.sql, keyOf(ctx.messageId), JSON.stringify({ at: now, ids: offered.length ? offered : ids }));
  ctx.host.sql.exec("DELETE FROM agent_state WHERE key LIKE 'recs:%' AND json_extract(value, '$.at') < ?", now - 2 * DAY_MS);
  return { ...shown, basis: a.basis };
}

export const recommendToolDef: ToolDef = {
  name: 'recommend_products',
  description: 'Suggest products from this store the customer may like: similar to one they looked at (basis similar), something that goes with it (complement), ideas after their order (after_order), or within a budget / for an occasion (budget, with query and maxPrice). Sends product cards. Use it only when the customer asks for ideas, alternatives or a budget, or once after you confirmed their order. Never repeat it, never push products on a customer who did not ask.',
  parameters: {
    type: 'object',
    properties: {
      basis: { type: 'string', enum: ['similar', 'complement', 'after_order', 'budget'] },
      productId: { type: 'string', description: 'The `id` of the product from a search result (similar / complement).' },
      orderNumber: { type: 'string', description: 'The order number the customer wrote (after_order); omit for their latest order.' },
      maxPrice: { type: 'number', maximum: MAX_BUDGET, description: 'Budget ceiling in the store currency, as the customer said it (at most 1,000,000).' },
      query: { type: 'string', description: 'What the customer wants, in their words (budget / occasion).' },
    },
    required: ['basis'],
  },
};
