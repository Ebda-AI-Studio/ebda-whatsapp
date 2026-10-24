import { BACKUP_TIME_ZONE, nextLocalHour } from '../backup';
import { itemsBatch, listRetailerIds, type CatalogRequest } from '../meta/catalog-api';
import { plainAmount } from '../ordering/money';
import { addTask } from '../scheduler';
import type { CatalogRow } from '../store-bridge';
import { bridgeFor } from '../store-link';
import type { LinkHost } from './host';
import { readSettings } from './settings';

/** Nightly full reconcile runs after the 02:00 backup. */
export const RECONCILE_HOUR_LOCAL = 3;
const PRODUCTS_PER_RUN = 200;
const PRODUCT_IDS_PER_CALL = 50;
const ITEMS_PER_BATCH = 100;
const CATALOG_PAGE = 100;
const MAX_CATALOG_PAGES = 200;
export const CATALOG_RETRY_MS = 30_000;

/** Meta's feed price: decimal amount, a space, the currency. */
const feedPrice = (minor: number, currency: string) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')} ${currency}`;

/** A catalog row as a Meta feed item, or null when Meta would refuse it (no image). */
export function toFeedItem(r: CatalogRow, preferArabic: boolean): CatalogRequest | null {
  if (!r.imageUrl) return null;
  const title = (preferArabic && r.titleAr ? r.titleAr : r.title).slice(0, 150);
  return {
    method: 'UPDATE',
    data: {
      id: r.retailerId, title, description: (r.description ?? title).slice(0, 5000), availability: r.availability === 'in_stock' ? 'in stock' : 'out of stock',
      condition: 'new', price: feedPrice(r.priceMinor, r.currency), image_link: r.imageUrl, link: r.link, brand: r.brand ?? title,
    },
  };
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Ready = { catalogId: string; token: string; graphVersion: string };
function ready(host: LinkHost): Ready | null {
  const catalogId = readSettings(host).catalogId;
  return catalogId ? { catalogId, token: host.env.META_SYSTEM_TOKEN, graphVersion: host.env.META_GRAPH_VERSION } : null;
}

async function send(auth: Ready, requests: CatalogRequest[]): Promise<void> {
  for (const part of chunk(requests, ITEMS_PER_BATCH)) {
    const res = await itemsBatch(auth, part);
    if (!res.ok) throw new Error(`catalog items_batch: ${res.message}`);
  }
}

/** Schedules the nightly reconcile if the catalog is configured. Keeps an already-pending earlier one. */
export function ensureCatalogReconcile(host: LinkHost, now: number, soon = false): void {
  if (!readSettings(host).catalogId) return;
  addTask(host.sql, 'catalog_reconcile', soon ? now + CATALOG_RETRY_MS : nextLocalHour(now, RECONCILE_HOUR_LOCAL, BACKUP_TIME_ZONE));
}

/**
 * Pushes the changed products to the merchant's Meta catalog. Changes are coalesced (one task, 30 s debounce) and removed
 * from the dirty table only after Meta accepted them AND they did not change again meanwhile. Returns when to run again
 * (more waiting, or a change landed during the run), or undefined when the table is empty.
 */
export async function runCatalogSync(host: LinkHost, now: number): Promise<number | undefined> {
  const auth = ready(host);
  const bridge = bridgeFor(host.env);
  if (!auth || !bridge) return undefined; // off: the rows stay, and configuring the catalog schedules a full reconcile
  const dirty = host.sql.exec<{ product_id: string; variant_ids: string; deleted: number; updated_at: number }>('SELECT product_id, variant_ids, deleted, updated_at FROM catalog_dirty ORDER BY updated_at LIMIT ?', PRODUCTS_PER_RUN).toArray();
  if (!dirty.length) return undefined;
  const profile = await bridge.getStoreProfile(host.workspaceId);
  const preferArabic = profile.ok ? profile.value.locale === 'ar' : true;
  const requests: CatalogRequest[] = [];
  let skipped = 0;
  const live = dirty.filter((d) => d.deleted === 0).map((d) => d.product_id);
  for (const ids of chunk(live, PRODUCT_IDS_PER_CALL)) {
    const res = await bridge.getProducts(host.workspaceId, ids);
    if (!res.ok) throw new Error(`catalog read from the Store failed: ${res.reason}`);
    for (const row of res.value.items) {
      const item = toFeedItem(row, preferArabic);
      if (item) requests.push(item);
      else skipped++;
    }
  }
  for (const d of dirty.filter((x) => x.deleted === 1)) for (const id of JSON.parse(d.variant_ids) as string[]) requests.push({ method: 'DELETE', data: { id } });
  await send(auth, requests);
  host.storage.transactionSync(() => {
    for (const d of dirty) host.sql.exec('DELETE FROM catalog_dirty WHERE product_id = ? AND updated_at = ?', d.product_id, d.updated_at);
  });
  console.log(JSON.stringify({ audit: 'catalog_sync', workspace: host.workspaceId, sent: requests.length, skipped }));
  return host.sql.exec('SELECT 1 FROM catalog_dirty LIMIT 1').toArray().length ? now + CATALOG_RETRY_MS : undefined;
}

/**
 * Safety net for missed events: re-sends the Store's whole catalog and archives what Meta has but the Store does not.
 * An empty Store answer never archives anything (an outage or a bug must not wipe a live catalog).
 */
export async function runCatalogReconcile(host: LinkHost, now: number): Promise<number | undefined> {
  const auth = ready(host);
  const bridge = bridgeFor(host.env);
  if (!auth || !bridge) return undefined;
  // What was waiting when this run began: covered by it, unless it changes again while we run.
  const covered = host.sql.exec<{ product_id: string; updated_at: number }>('SELECT product_id, updated_at FROM catalog_dirty').toArray();
  const profile = await bridge.getStoreProfile(host.workspaceId);
  const preferArabic = profile.ok ? profile.value.locale === 'ar' : true;
  const rows: CatalogRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const res = await bridge.listCatalog(host.workspaceId, cursor, CATALOG_PAGE);
    if (!res.ok) throw new Error(`catalog read from the Store failed: ${res.reason}`);
    rows.push(...res.value.items);
    cursor = res.value.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error('catalog read from the Store did not finish');
  const requests: CatalogRequest[] = [];
  let skipped = 0;
  for (const r of rows) {
    const item = toFeedItem(r, preferArabic);
    if (item) requests.push(item);
    else skipped++;
  }
  const have = await listRetailerIds(auth);
  if (!have.ok) throw new Error(`catalog list from Meta failed: ${have.message}`);
  const wanted = new Set(rows.map((r) => r.retailerId));
  const extras = rows.length ? have.value.filter((id) => !wanted.has(id)) : [];
  for (const id of extras) requests.push({ method: 'DELETE', data: { id } });
  await send(auth, requests);
  host.storage.transactionSync(() => {
    for (const d of covered) host.sql.exec('DELETE FROM catalog_dirty WHERE product_id = ? AND updated_at = ?', d.product_id, d.updated_at);
  });
  console.log(JSON.stringify({ audit: 'catalog_reconcile', workspace: host.workspaceId, sent: requests.length, archived: extras.length, skipped }));
  return nextLocalHour(now + 3_600_000, RECONCILE_HOUR_LOCAL, BACKUP_TIME_ZONE);
}
