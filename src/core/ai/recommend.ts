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
import { putAgentState } from './settings';
import type { ToolDef } from './provider';
import type { ToolContext } from './tools';

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
  maxPrice: z.number().positive().max(10_000_000).optional(),
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

export async function recommendProducts(ctx: ToolContext, a: RecommendArgs, deps: RecommendDeps, now = Date.now()): Promise<unknown> {
  const bridge = ctx.bridge!;
  if (ctx.recommended) return { error: 'already_recommended_this_turn' };
  const win = windowOf(ctx, now);
  if (win.count >= RECS_PER_DAY) return { error: 'rate_limited', note: 'Enough suggestions were sent already today: answer in plain words, do not suggest more products.' };

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
        if (!latest.ok) return { error: 'store_unavailable' };
        orderNumber = latest.value.items[0]?.orderNumber;
        if (!orderNumber) return { error: 'no_order' };
      }
      Object.assign(req, { orderNumber, buyerKey: key, phoneE164: e164 });
    } else {
      if (!a.productId) return { error: 'invalid_arguments' };
      req.seedIds = [a.productId];
    }
    const res = await bridge.getRecommendations(ctx.host.workspaceId, req);
    if (!res.ok) return { error: res.reason === 'not_found' ? 'not_found' : 'store_unavailable' };
    // The engine's answer is re-checked here too: in stock, inside the budget, not the seed, not already suggested to this customer.
    candidates = res.value.items.filter((r) => r.availability === 'in_stock' && (maxPriceMinor === undefined || r.priceMinor <= maxPriceMinor) && r.retailerId !== a.productId).map((r) => r.retailerId);
  }
  const ids = [...new Set(candidates)].filter((id) => !win.shown.has(id)).slice(0, RECS_PER_SET);
  if (!ids.length) return { error: 'nothing_to_recommend', note: 'Say so plainly; do not invent products.' };

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
      maxPrice: { type: 'number', description: 'Budget ceiling in the store currency, as the customer said it.' },
      query: { type: 'string', description: 'What the customer wants, in their words (budget / occasion).' },
    },
    required: ['basis'],
  },
};
