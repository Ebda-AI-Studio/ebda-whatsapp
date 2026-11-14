import { PRODUCT_LIST_MAX_ITEMS, PRODUCT_LIST_MAX_SECTIONS } from '../meta/client';
import type { Locale, OrderingCopy } from '../ordering/copy';
import type { SendJob } from '../send-queue';
import type { CatalogRow } from '../store-bridge';
import type { LinkHost } from './host';
import { getState, readSettings } from './settings';

/** The card text and the job shape, without the addressee (a card is stored as this, never with a phone number). */
export type CardSpec =
  | { kind: 'product'; product: NonNullable<SendJob['product']> }
  | { kind: 'product_list'; productList: NonNullable<SendJob['productList']> }
  | { kind: 'catalog'; catalog: NonNullable<SendJob['catalog']> };

export type BuiltCard = { spec: CardSpec; preview: string };

const cut = (s: string, n: number) => (Array.from(s).length <= n ? s : `${Array.from(s).slice(0, n - 1).join('')}…`);
const nameOf = (r: Pick<CatalogRow, 'title' | 'titleAr'>, locale: Locale) => (locale === 'ar' && r.titleAr ? r.titleAr : r.title);

export type CardRow = Pick<CatalogRow, 'retailerId' | 'productId' | 'title' | 'titleAr' | 'priceMinor' | 'currency'>;

/**
 * Product cards for rows the catalogue holds: one card for one product, else a multi-product message. At most 30 products and 10 sections
 * (Meta's limits; the rest is dropped, never sent as a message Meta would refuse). Rows of one product with several variants share a section
 * titled with the product; otherwise one section holds them all. Pure.
 */
export function buildProductCards(rows: CardRow[], catalogId: string, copy: OrderingCopy, locale: Locale): BuiltCard[] {
  const unique = [...new Map(rows.map((r) => [r.retailerId, r])).values()].slice(0, PRODUCT_LIST_MAX_ITEMS);
  const money = (r: CardRow) => copy.money(r.priceMinor, r.currency, locale);
  if (!unique.length) return [];
  if (unique.length === 1) {
    const r = unique[0]!;
    const body = cut(copy.t.cards.single(nameOf(r, locale), money(r), locale), 1024);
    return [{ spec: { kind: 'product', product: { catalogId, retailerId: r.retailerId, body } }, preview: body }];
  }
  const byProduct = new Map<string, CardRow[]>();
  for (const r of unique) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);
  const groups = [...byProduct.values()];
  const grouped = groups.length > 1 && groups.some((g) => g.length > 1);
  const sections: { title: string; retailerIds: string[] }[] = [];
  if (!grouped) sections.push({ title: cut(copy.t.cards.listSection[locale], 24), retailerIds: unique.map((r) => r.retailerId) });
  else {
    const own = groups.length <= PRODUCT_LIST_MAX_SECTIONS ? groups : groups.slice(0, PRODUCT_LIST_MAX_SECTIONS - 1);
    for (const g of own) sections.push({ title: cut(nameOf(g[0]!, locale), 24), retailerIds: g.map((r) => r.retailerId) });
    if (own.length < groups.length) sections.push({ title: cut(copy.t.cards.moreSection[locale], 24), retailerIds: groups.slice(own.length).flat().map((r) => r.retailerId) });
  }
  const body = cut(copy.t.cards.listBody[locale], 1024);
  return [{ spec: { kind: 'product_list', productList: { catalogId, header: cut(copy.t.cards.listHeader[locale], 60), body, sections } }, preview: body }];
}

export function buildCatalogCard(copy: OrderingCopy, locale: Locale, thumbnailRetailerId?: string): BuiltCard {
  const body = cut(copy.t.cards.catalogBody[locale], 1024);
  return { spec: { kind: 'catalog', catalog: { body, footer: cut(copy.t.cards.catalogFooter[locale], 60), ...(thumbnailRetailerId ? { thumbnailRetailerId } : {}) } }, preview: body };
}

/** The job for a card, addressed. */
export function cardJob(base: Pick<SendJob, 'workspaceId' | 'phoneNumberId' | 'to' | 'idempotencyKey'>, spec: CardSpec): SendJob {
  switch (spec.kind) {
    case 'product': return { ...base, kind: 'product', product: spec.product };
    case 'product_list': return { ...base, kind: 'product_list', productList: spec.productList };
    case 'catalog': return { ...base, kind: 'catalog', catalog: spec.catalog };
  }
}

/**
 * Which of these retailer ids are really in the merchant's Meta catalogue: the catalogue is connected and verified for this workspace, and the sync
 * ledger says the item went in (a card for an item Meta does not have is refused by Meta, and the customer would see nothing).
 * Empty = no cards; the caller falls back to text with links.
 */
export function cardableIds(host: Pick<LinkHost, 'sql'>, ids: string[]): { catalogId: string; ids: string[] } | null {
  const catalogId = readSettings(host).catalogId;
  if (!catalogId || !getState(host, 'catalog.waba')) return null;
  const synced = new Set<string>();
  for (const id of ids) {
    if (host.sql.exec("SELECT 1 FROM catalog_items WHERE retailer_id = ? AND status = 'synced'", id).toArray().length) synced.add(id);
  }
  const have = ids.filter((id) => synced.has(id));
  return have.length ? { catalogId, ids: have } : null;
}

/** The catalogue button needs a connected catalogue with at least one item in it. Returns a thumbnail (an in-stock item's id when known). */
export function catalogueOpenable(host: Pick<LinkHost, 'sql'>): { thumbnail: string | null } | null {
  const catalogId = readSettings(host).catalogId;
  if (!catalogId || !getState(host, 'catalog.waba')) return null;
  const row = host.sql.exec<{ retailer_id: string }>("SELECT retailer_id FROM catalog_items WHERE status = 'synced' ORDER BY updated_at DESC LIMIT 1").toArray()[0];
  return row ? { thumbnail: row.retailer_id } : null;
}
