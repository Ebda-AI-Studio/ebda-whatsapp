/**
 * The tools the agent may call. The model supplies only what a customer could type: it never names a phone number or a
 * customer key (those come from the conversation itself), and prices, stock and order state always come from the Store at the
 * moment of the call, never from an index.
 */
import { z } from 'zod';
import { buyerKey } from '../buyer-key';
import { errClass, alert } from '../observability';
import { isE164 } from '../phone';
import type { LinkHost } from '../store-link/host';
import { MAX_RETAILER_ID, type CatalogRow, type StoreBridge } from '../store-bridge';
import { storeLink } from '../store-link';
import { normaliseText } from '../text-normalise';
import { buildCatalogCard, buildProductCards, cardableIds, catalogueOpenable, type BuiltCard } from '../store-link/product-cards';
import { catalogCandidates } from './knowledge';
import type { ToolCall, ToolDef } from './provider';

export const MAX_TOOL_ROUNDS = 3;
export const MAX_CALLS_PER_ROUND = 3;
/** F2: tool calls (built-in and connector) one turn may EXECUTE; a call past the budget is answered with `tool_budget` and does nothing. */
export const MAX_TOOL_CALLS_PER_TURN = 6;
const SEARCH_PAGES = 5;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_RESULTS = 5;

export type ToolAvailability = { catalog: boolean; orders: boolean; ordering: boolean };

export function toolDefs(a: ToolAvailability): ToolDef[] {
  const defs: ToolDef[] = [];
  if (a.catalog) {
    defs.push({
      name: 'search_catalog',
      description: 'Find products in the store by name, type or description. Returns up to 5 matches with current price, availability and link.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What the customer is looking for, in their words.' } }, required: ['query'] },
    });
    defs.push({
      name: 'show_products',
      description: 'Send the customer product cards (picture, price, add-to-cart) in the chat for products you found with search_catalog. Pass the `id` values from the search results (at most 10). Use it whenever the customer asks to see, compare or choose products.',
      parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'The `id` of each product to show, from search_catalog.' } }, required: ['ids'] },
    });
    defs.push({
      name: 'open_catalog',
      description: 'Send the "View catalog" button that opens the store\'s whole catalogue on WhatsApp. Use it when the customer wants to browse everything or asks what you sell.',
      parameters: { type: 'object', properties: {} },
    });
  }
  if (a.orders) {
    defs.push({
      name: 'order_status',
      description: "Look up the customer's own order status and shipment. Give an order number if the customer mentioned one; otherwise the latest orders are returned.",
      parameters: { type: 'object', properties: { orderNumber: { type: 'string', description: 'The order number the customer wrote, if any.' } } },
    });
  }
  if (a.ordering) {
    defs.push({
      name: 'start_order',
      description: 'Use when the customer wants to buy or place an order: it opens the ordering menu in this chat.',
      parameters: { type: 'object', properties: {} },
    });
  }
  defs.push({
    name: 'handoff_to_human',
    description: 'Use when you cannot answer, the customer is upset or has a complaint or special request, or asks for a person. A team member takes over.',
    parameters: { type: 'object', properties: {} },
  });
  return defs;
}

export type ToolOutcome = { content: string } | { handoff: true } | { startOrder: true };
/** `cards` collects the catalogue messages a turn asked for; the agent sends them after its text. */
export type ToolContext = { host: LinkHost; from: string; bridge: StoreBridge | null; availability: ToolAvailability; locale: 'ar' | 'en'; cards: BuiltCard[]; /** Rows shown by show_products this turn: one product message is built from all of them (WA-CAT-5). */ shown?: CatalogRow[] };

const searchArgs = z.object({ query: z.string().trim().min(1).max(120) });
const showArgs = z.object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(10) });
const statusArgs = z.object({ orderNumber: z.string().trim().regex(/^[\w-]{1,40}$/).optional() });
const json = (v: unknown): ToolOutcome => ({ content: JSON.stringify(v).slice(0, 3000) });
const err = (code: string): ToolOutcome => json({ error: code });

export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> {
  try {
    switch (call.name) {
      case 'search_catalog': {
        if (!ctx.availability.catalog || !ctx.bridge) return err('unavailable');
        const args = searchArgs.safeParse(call.arguments);
        if (!args.success) return err('invalid_arguments');
        return json(await searchCatalog(ctx, args.data.query));
      }
      case 'show_products': {
        if (!ctx.availability.catalog || !ctx.bridge) return err('unavailable');
        const args = showArgs.safeParse(call.arguments);
        if (!args.success) return err('invalid_arguments');
        return json(await showProducts(ctx, args.data.ids));
      }
      case 'open_catalog': {
        if (!ctx.availability.catalog) return err('unavailable');
        const copy = storeLink().copy;
        const open = catalogueOpenable(ctx.host);
        if (!copy || !open) return err('catalogue_unavailable');
        if (!ctx.cards.some((c) => c.spec.kind === 'catalog')) ctx.cards.push(buildCatalogCard(copy, ctx.locale, open.thumbnail ?? undefined));
        return json({ opened: true });
      }
      case 'order_status': {
        if (!ctx.availability.orders || !ctx.bridge) return err('unavailable');
        const args = statusArgs.safeParse(call.arguments ?? {});
        if (!args.success) return err('invalid_arguments');
        return json(await orderStatus(ctx, args.data.orderNumber));
      }
      case 'start_order':
        return ctx.availability.ordering ? { startOrder: true } : err('unavailable');
      case 'handoff_to_human':
        return { handoff: true };
      default:
        return err('unknown_tool');
    }
  } catch (e) {
    alert('agent_tool_failed', { workspace: ctx.host.workspaceId, tool: call.name.slice(0, 40), error: errClass(e) });
    return err('tool_failed');
  }
}

type Hit = { id: string; name: string; nameAr: string | null; price: number; currency: string; inStock: boolean; link: string };
const toHit = (r: CatalogRow): Hit => ({ id: r.retailerId, name: r.title, nameAr: r.titleAr, price: r.priceMinor / 100, currency: r.currency, inStock: r.availability === 'in_stock', link: r.link });

/**
 * Product cards for products the catalogue really holds (checked against the sync ledger), read live from the Store just now (price and stock are
 * never taken from the model or an index). Out-of-stock products get no card. With no connected catalogue the answer says so and carries the links,
 * and the model writes a text reply instead.
 */
async function showProducts(ctx: ToolContext, ids: string[]): Promise<unknown> {
  // The Store refuses the whole call for one id over 64 characters: drop those (the model sent something that is not a retailer id of ours).
  const askable = [...new Set(ids)].filter((id) => id.length <= MAX_RETAILER_ID);
  if (!askable.length) return { error: 'not_available' };
  const res = await ctx.bridge!.getProducts(ctx.host.workspaceId, askable);
  if (!res.ok) return { error: 'store_unavailable' };
  const inStock = res.value.items.filter((r) => r.availability === 'in_stock');
  if (!inStock.length) return { error: 'not_available' };
  const copy = storeLink().copy;
  const cardable = copy ? cardableIds(ctx.host, inStock.map((r) => r.retailerId)) : null;
  if (!copy || !cardable) return { cards_unavailable: true, products: inStock.slice(0, SEARCH_RESULTS).map(toHit) };
  const shown = inStock.filter((r) => cardable.ids.includes(r.retailerId));
  // One product message per turn, however many calls the model makes: every row shown so far, deduplicated and capped by the builder.
  const all = (ctx.shown = [...new Map([...(ctx.shown ?? []), ...shown].map((r) => [r.retailerId, r])).values()]);
  ctx.cards.splice(0, ctx.cards.length, ...buildProductCards(all, cardable.catalogId, copy, ctx.locale), ...ctx.cards.filter((c) => c.spec.kind === 'catalog'));
  return { cards_sent: shown.length, products: shown.map(toHit), without_card: inStock.filter((r) => !cardable.ids.includes(r.retailerId)).map(toHit) };
}

/** Words of the query: normalised, at most six. A single character (a digit: "item 3") counts only as a whole word. */
const tokens = (q: string): string[] => [...new Set(normaliseText(q).split(' ').filter(Boolean))].slice(0, 6);

/** Rows whose text contains the most query words (in stock first on a tie). Pure, so the order of results is testable. */
export function rankRows(rows: CatalogRow[], query: string): CatalogRow[] {
  const words = tokens(query);
  if (!words.length) return [];
  return rows
    .map((r) => {
      const hay = normaliseText(`${r.title} ${r.titleAr ?? ''} ${r.description ?? ''} ${r.brand ?? ''}`);
      const whole = new Set(hay.split(' '));
      // a whole word weighs more than a fragment (Arabic prefixes such as ال make fragments useful)
      return { r, score: words.reduce((n, w) => n + (whole.has(w) ? 3 : w.length >= 2 && hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.r.availability === 'in_stock') - Number(a.r.availability === 'in_stock'))
    .map((x) => x.r);
}

/**
 * Search without an index: read the Store's catalog (up to 500 variants) and rank by matching words. The semantic index (when
 * Vectorize exists) only finds candidates; the rows returned here are always read from the Store just now.
 */
async function searchCatalog(ctx: ToolContext, query: string): Promise<{ results: Hit[] } | { error: string }> {
  const bridge = ctx.bridge!;
  // The index only names candidate products; what is shown (price, stock, link) is read from the Store right now.
  const ids = await catalogCandidates(ctx.host, query);
  if (ids) {
    // The index names RETAILER ids (what the Store's `getProducts` answers to, variants included), best match first.
    const fresh = await bridge.getProducts(ctx.host.workspaceId, ids);
    if (fresh.ok && fresh.value.items.length) {
      const rank = new Map(ids.map((id, i) => [id, i]));
      return { results: fresh.value.items.sort((a, b) => (rank.get(a.retailerId) ?? 99) - (rank.get(b.retailerId) ?? 99)).slice(0, SEARCH_RESULTS).map(toHit) };
    }
  }
  const rows: CatalogRow[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < SEARCH_PAGES; p++) {
    const res = await bridge.listCatalog(ctx.host.workspaceId, cursor, SEARCH_PAGE_SIZE);
    if (!res.ok) return { error: 'store_unavailable' };
    rows.push(...res.value.items);
    cursor = res.value.nextCursor;
    if (!cursor) break;
  }
  return { results: rankRows(rows, query).slice(0, SEARCH_RESULTS).map(toHit) };
}

async function orderStatus(ctx: ToolContext, orderNumber: string | undefined): Promise<unknown> {
  const secret = storeLink().buyerSecret(ctx.host.env);
  const e164 = `+${ctx.from}`;
  if (!secret || !isE164(e164)) return { error: 'unavailable' };
  const key = await buyerKey(secret, e164);
  const bridge = ctx.bridge!;
  if (orderNumber) {
    const res = await bridge.getOrderStatus(ctx.host.workspaceId, orderNumber, key);
    if (!res.ok) return { error: res.reason === 'not_found' ? 'order_not_found' : 'store_unavailable' };
    return { orderNumber: res.value.orderNumber, status: res.value.status, paymentMethod: res.value.paymentMethod, shipment: res.value.shipment };
  }
  const res = await bridge.listCustomerOrders(ctx.host.workspaceId, key, 3);
  if (!res.ok) return { error: res.reason === 'not_found' || res.reason === 'not_linked' ? 'no_orders' : 'store_unavailable' };
  return { orders: res.value.items.map((o) => ({ orderNumber: o.orderNumber, status: o.status, paymentMethod: o.paymentMethod, total: o.totalMinor / 100, currency: o.currency, items: o.itemsCount })) };
}
