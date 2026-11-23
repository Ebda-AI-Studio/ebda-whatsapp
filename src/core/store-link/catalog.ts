import { BACKUP_TIME_ZONE, nextLocalHour } from '../backup';
import { checkBatchStatus, isPermissionFailure, itemsBatch, listRetailerIds, listWabaCatalogs, type CatalogRequest } from '../meta/catalog-api';
import { ensureCommerce } from './catalog-commerce';
import { plainAmount } from '../ordering/money';
import { addTask } from '../scheduler';
import type { CatalogRow } from '../store-bridge';
import { bridgeForWorkspace } from '../store-link';
import type { Env } from '../../env';
import { graphTokenFor, TokenUnavailable } from '../numbers/token';
import type { LinkHost } from './host';
import { getState, putState, readSettings } from './settings';
import { alert } from '../observability';

/** Nightly full reconcile runs after the 02:00 backup. */
export const RECONCILE_HOUR_LOCAL = 3;
const PRODUCTS_PER_RUN = 200;
const PRODUCT_IDS_PER_CALL = 50;
const ITEMS_PER_BATCH = 100;
const CATALOG_PAGE = 100;
const MAX_CATALOG_PAGES = 200;
export const CATALOG_RETRY_MS = 30_000;
/** store_state key: epoch ms of the last run that Meta accepted (event sync or reconcile). */
export const LAST_SYNC_KEY = 'catalog.last_sync';

/** Meta's feed price: decimal amount, a space, the currency. */
const feedPrice = (minor: number, currency: string) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')} ${currency}`;

/** Why a Store row is left out of the Meta catalogue. Shown to the merchant (never silently dropped). */
export type ExcludedReason = 'no_image' | 'bad_image' | 'no_title';
export type FeedResult = { item: CatalogRequest } | { reason: ExcludedReason };

/**
 * A catalog row as a Meta feed item, or the reason Meta would refuse it. The retailer id is `CatalogRow.retailerId` verbatim
 * (Ruling WA-CAT-1); a row whose retailer id differs from its product id is a variant and joins its product's group (`item_group_id`).
 */
export function feedItem(r: CatalogRow, preferArabic: boolean): FeedResult {
  if (!r.imageUrl) return { reason: 'no_image' };
  if (!/^https:\/\/\S+$/.test(r.imageUrl)) return { reason: 'bad_image' };
  const title = (preferArabic && r.titleAr ? r.titleAr : r.title).trim().slice(0, 150);
  if (!title) return { reason: 'no_title' };
  return {
    item: {
      method: 'UPDATE',
      data: {
        id: r.retailerId, title, description: (r.description?.trim() || title).slice(0, 5000), availability: r.availability === 'in_stock' ? 'in stock' : 'out of stock',
        condition: 'new', price: feedPrice(r.priceMinor, r.currency), image_link: r.imageUrl, link: r.link, brand: r.brand ?? title,
        ...(r.retailerId !== r.productId ? { item_group_id: r.productId } : {}),
      },
    },
  };
}

/** Kept for callers that only need the item: null when Meta would refuse the row. */
export function toFeedItem(r: CatalogRow, preferArabic: boolean): CatalogRequest | null {
  const f = feedItem(r, preferArabic);
  return 'item' in f ? f.item : null;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export type Ready = { catalogId: string; token: string; graphVersion: string };

/** Reconcile may archive at most this share of Meta's catalog (and more than MASS_DELETE_MIN items) in one automatic run. */
export const MASS_DELETE_SHARE = 0.2;
export const MASS_DELETE_MIN = 10;

/**
 * A catalog id is a capability on the platform's own token, so it is only ever used while it is provably THIS business's:
 * the workspace must still own an active number on the WABA the id was verified against, and Meta must still list the
 * catalog among that WABA's catalogs. Checked before every write run. Null = not usable (and nothing is written).
 */
export async function verifiedAuth(host: LinkHost): Promise<Ready | null> {
  const catalogId = readSettings(host).catalogId;
  if (!catalogId) return null;
  const refuse = (why: string): null => {
    alert('catalog_not_linked', { workspace: host.workspaceId, why });
    return null;
  };
  const wabaId = getState(host, 'catalog.waba');
  if (!wabaId) return refuse('no_verified_waba');
  const owns = await host.env.DB.prepare("SELECT 1 FROM phone_numbers WHERE workspace_id = ? AND waba_id = ? AND status = 'active'").bind(host.workspaceId, wabaId).first();
  if (!owns) return refuse('waba_not_owned');
  const auth = { token: await graphTokenFor(host.env, { wabaId }), graphVersion: host.env.META_GRAPH_VERSION };
  const listed = await listWabaCatalogs({ ...auth, wabaId });
  if (!listed.ok) throw new Error(`catalog verification failed: ${listed.message}`); // an outage, not an answer: retry
  if (!listed.value.includes(catalogId)) return refuse('not_in_waba');
  return { catalogId, ...auth };
}

/** Is `catalogId` connected to this WABA? Used before a catalog id is saved. */
export async function catalogBelongsToWaba(env: Env, wabaId: string, catalogId: string): Promise<'yes' | 'no' | 'unavailable'> {
  let token: string;
  try {
    token = await graphTokenFor(env, { wabaId });
  } catch (err) {
    if (err instanceof TokenUnavailable) return 'unavailable';
    throw err;
  }
  const listed = await listWabaCatalogs({ token, graphVersion: env.META_GRAPH_VERSION, wabaId });
  if (!listed.ok) return 'unavailable';
  return listed.value.includes(catalogId) ? 'yes' : 'no';
}

// ---- the ledger of what is in the Meta catalogue ----------------------------------------------------------------------

/** store_state keys. */
const PASS_KEY = 'catalog.pass';
const HANDLES_KEY = 'catalog.handles';
export const LAST_ERROR_KEY = 'catalog.last_error';
const FAIL_COUNT_KEY = 'catalog.fail_count';
/** One full pass reads this many Store pages (100 products each) per run, then comes back: a big catalogue never runs into one invocation's subrequest limit. */
export const RECONCILE_PAGES_PER_RUN = 3;
/** A pass that has not finished in this long is abandoned and started over. */
const PASS_MAX_AGE_MS = 48 * 3_600_000;
const FAIL_ALERT_AT = 3;

type PassState = { id: number; cursor: string | null; seen: number; started: number };
const readPass = (host: LinkHost): PassState | null => {
  try {
    const raw = getState(host, PASS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<PassState>) : null;
    return v && typeof v.id === 'number' && typeof v.started === 'number' ? { id: v.id, cursor: v.cursor ?? null, seen: v.seen ?? 0, started: v.started } : null;
  } catch {
    return null;
  }
};

/** Records what was decided for each row: in the catalogue, or left out and why. `pass` is the full pass running now (0 = none), so a late event row is never mistaken for a stray at the end of the pass. */
function ledger(host: LinkHost, row: CatalogRow, result: FeedResult, pass: number, now: number): void {
  const [status, reason] = 'item' in result ? ['synced', null] : ['excluded', result.reason];
  host.sql.exec(
    `INSERT INTO catalog_items (retailer_id, product_id, group_id, status, reason, pass, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(retailer_id) DO UPDATE SET product_id = excluded.product_id, group_id = excluded.group_id, status = excluded.status, reason = excluded.reason, pass = excluded.pass, updated_at = excluded.updated_at`,
    row.retailerId, row.productId, row.retailerId !== row.productId ? row.productId : null, status, reason, pass, now,
  );
}
const forget = (host: LinkHost, ids: string[]): void => {
  for (const id of ids) host.sql.exec('DELETE FROM catalog_items WHERE retailer_id = ?', id);
};
/** The retailer ids the ledger holds for a product (empty before the first pass). */
export const idsOfProduct = (host: Pick<LinkHost, 'sql'>, productId: string): string[] => host.sql.exec<{ retailer_id: string }>('SELECT retailer_id FROM catalog_items WHERE product_id = ?', productId).toArray().map((r) => r.retailer_id);

/**
 * Rows to requests. A row Meta would refuse is left out. If it was in the catalogue (ledger `synced`) it is DELETEd; on the event path
 * (`phantomDelete`) it is DELETEd unless the ledger already says it is excluded, because the ledger may be empty for items the pre-ledger code
 * pushed and a phantom DELETE is harmless. (The full pass instead deletes what Meta really lists and we exclude, at its end.)
 * The ledger is NOT written here: `commit()` writes it, and the caller calls it only after Meta accepted the batch, so the ledger never claims
 * more than Meta holds and a failed send is simply planned again (WA-CAT-5).
 */
function plan(host: LinkHost, rows: CatalogRow[], preferArabic: boolean, pass: number, now: number, phantomDelete = false): { requests: CatalogRequest[]; excluded: number; commit: () => void } {
  const requests: CatalogRequest[] = [];
  const writes: (() => void)[] = [];
  let excluded = 0;
  for (const r of rows) {
    const f = feedItem(r, preferArabic);
    const was = host.sql.exec<{ status: string }>('SELECT status FROM catalog_items WHERE retailer_id = ?', r.retailerId).toArray()[0]?.status;
    writes.push(() => ledger(host, r, f, pass, now));
    if ('item' in f) requests.push(f.item);
    else {
      excluded++;
      if (was === 'synced' || (phantomDelete && was !== 'excluded')) requests.push({ method: 'DELETE', data: { id: r.retailerId } });
    }
  }
  return { requests, excluded, commit: () => { for (const w of writes) w(); } };
}

const asPermission = (message: string, code?: number) => Object.assign(new Error(`catalog items_batch: ${message}`), { metaCode: code });

/** Sends the requests in batches; remembers each batch handle so Meta's verdict is read on the next run (the batch is ingested asynchronously). */
async function send(host: LinkHost, auth: Ready, requests: CatalogRequest[]): Promise<void> {
  const handles: string[] = [];
  for (const part of chunk(requests, ITEMS_PER_BATCH)) {
    const res = await itemsBatch(auth, part);
    if (!res.ok) {
      if (isPermissionFailure(res)) alert('catalog_permission_missing', { workspace: host.workspaceId, code: res.code ?? null });
      throw asPermission(res.message, res.code);
    }
    if (res.value.handle) handles.push(res.value.handle);
  }
  if (handles.length) {
    const pending = readHandles(host).concat(handles.map((handle) => ({ handle, tries: 0 }))).slice(-30);
    putState(host, HANDLES_KEY, JSON.stringify(pending));
  }
}

type Pending = { handle: string; tries: number };
const readHandles = (host: LinkHost): Pending[] => {
  try {
    const v = JSON.parse(getState(host, HANDLES_KEY) ?? '[]') as Pending[];
    return Array.isArray(v) ? v.filter((x) => typeof x?.handle === 'string') : [];
  } catch {
    return [];
  }
};

/** Reads Meta's verdict on earlier batches: an id it refused becomes `rejected` (shown to the merchant, alerted once). Never throws: a status read that fails is tried again next run. */
async function settleBatches(host: LinkHost, auth: Ready): Promise<void> {
  const pending = readHandles(host).slice(0, 5);
  if (!pending.length) return;
  const rest = readHandles(host).slice(5);
  const keep: Pending[] = [];
  let rejected = 0;
  for (const p of pending) {
    const res = await checkBatchStatus({ token: auth.token, graphVersion: auth.graphVersion, catalogId: auth.catalogId, handle: p.handle });
    if (!res.ok || !res.value.finished) {
      if (p.tries < 8) keep.push({ handle: p.handle, tries: p.tries + 1 });
      continue;
    }
    for (const id of res.value.invalidIds) {
      // Only an id this workspace put in (a phantom DELETE of something Meta never had is no news).
      if (host.sql.exec("UPDATE catalog_items SET status = 'rejected', reason = 'meta_rejected' WHERE retailer_id = ? AND status = 'synced'", id).rowsWritten > 0) rejected++;
    }
  }
  putState(host, HANDLES_KEY, JSON.stringify([...keep, ...rest]));
  if (rejected) alert('catalog_items_rejected', { workspace: host.workspaceId, items: rejected });
}

/** Failures are counted; the third in a row (and every tenth after) alerts. A permission failure is stored as such so the merchant is told what to do. */
async function guarded<T>(host: LinkHost, run: () => Promise<T>): Promise<T> {
  try {
    const out = await run();
    host.sql.exec("DELETE FROM store_state WHERE key IN (?, ?)", LAST_ERROR_KEY, FAIL_COUNT_KEY);
    return out;
  } catch (err) {
    const code = (err as { metaCode?: number }).metaCode;
    putState(host, LAST_ERROR_KEY, code !== undefined && isPermissionFailure({ code }) ? 'missing_permission' : 'sync_failed');
    const n = Number(getState(host, FAIL_COUNT_KEY) ?? '0') + 1;
    putState(host, FAIL_COUNT_KEY, String(n));
    if (n === FAIL_ALERT_AT || (n > FAIL_ALERT_AT && n % 10 === 0)) alert('catalog_sync_stuck', { workspace: host.workspaceId, failures: n, code: code ?? null });
    throw err;
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
export function runCatalogSync(host: LinkHost, now: number): Promise<number | undefined> {
  return guarded(host, () => syncOnce(host, now));
}

async function syncOnce(host: LinkHost, now: number): Promise<number | undefined> {
  const bridge = bridgeForWorkspace(host.env, host.workspaceId);
  if (!bridge || !readSettings(host).catalogId) return undefined;
  const auth = await verifiedAuth(host);
  if (!auth) return undefined; // off: the rows stay, and configuring the catalog schedules a full reconcile
  const dirty = host.sql.exec<{ product_id: string; variant_ids: string; deleted: number; updated_at: number }>('SELECT product_id, variant_ids, deleted, updated_at FROM catalog_dirty ORDER BY updated_at LIMIT ?', PRODUCTS_PER_RUN).toArray();
  if (!dirty.length) return undefined;
  await settleBatches(host, auth);
  const profile = await bridge.getStoreProfile(host.workspaceId);
  const preferArabic = profile.ok ? profile.value.locale === 'ar' : true;
  const pass = readPass(host)?.id ?? 0;
  const requests: CatalogRequest[] = [];
  const liveDirty = dirty.filter((d) => d.deleted === 0);
  // The Store's `getProducts` takes RETAILER ids: a product with variants answers only to its variants' ids (a simple product's retailer id is its own id).
  const wanted = liveDirty.flatMap((d) => [d.product_id, ...(JSON.parse(d.variant_ids) as string[])]);
  const rows: CatalogRow[] = [];
  for (const ids of chunk([...new Set(wanted)], PRODUCT_IDS_PER_CALL)) {
    const res = await bridge.getProducts(host.workspaceId, ids);
    if (!res.ok) throw new Error(`catalog read from the Store failed: ${res.reason}`);
    rows.push(...res.value.items);
  }
  const archive: string[] = [];
  // An ok but empty answer for products that were just changed is more likely a Store fault than a mass removal: archive nothing now, let a full pass (guarded) decide.
  const emptyAnswer = liveDirty.length > 0 && rows.length === 0;
  if (emptyAnswer) ensureCatalogReconcile(host, now, true);
  for (const d of emptyAnswer ? [] : liveDirty) {
    const mine = rows.filter((r) => r.productId === d.product_id);
    // A variant that left a live product, or a product the Store no longer has rows for, leaves the catalogue too.
    const keep = new Set(mine.map((r) => r.retailerId));
    archive.push(...idsOfProduct(host, d.product_id).filter((id) => !keep.has(id)));
  }
  const planned = plan(host, rows, preferArabic, pass, now, true);
  requests.push(...planned.requests);
  // The Store sends no ids for a deleted product: what the ledger holds for it (plus any ids the event did carry, plus its own id for a simple product) is archived.
  for (const d of dirty.filter((x) => x.deleted === 1)) {
    const known = [...idsOfProduct(host, d.product_id), ...(JSON.parse(d.variant_ids) as string[])];
    archive.push(...(known.length ? known : [d.product_id]));
  }
  const gone = [...new Set(archive)];
  for (const id of gone) requests.push({ method: 'DELETE', data: { id } });
  await send(host, auth, requests);
  host.storage.transactionSync(() => {
    forget(host, gone);
    planned.commit();
    for (const d of dirty) host.sql.exec('DELETE FROM catalog_dirty WHERE product_id = ? AND updated_at = ?', d.product_id, d.updated_at);
  });
  putState(host, LAST_SYNC_KEY, String(now));
  console.log(JSON.stringify({ audit: 'catalog_sync', workspace: host.workspaceId, sent: requests.length, skipped: planned.excluded }));
  return host.sql.exec('SELECT 1 FROM catalog_dirty LIMIT 1').toArray().length ? now + CATALOG_RETRY_MS : undefined;
}

/**
 * Safety net for missed events and the first fill: re-sends the Store's whole catalog and archives what Meta has but the Store does not.
 * It runs as a PASS, a few Store pages per run (cursor kept in state), so any catalogue size finishes; the archive step runs once at the end
 * of a pass, from the ledger of what the pass saw. An empty Store answer never archives anything (an outage or a bug must not wipe a live catalog).
 * Returns when to run again: soon while a pass is unfinished, the next 03:00 Cairo once it is done.
 */
export function runCatalogReconcile(host: LinkHost, now: number, opts: { allowMassDelete?: boolean } = {}): Promise<number | undefined> {
  return guarded(host, () => reconcileOnce(host, now, opts));
}

async function reconcileOnce(host: LinkHost, now: number, opts: { allowMassDelete?: boolean }): Promise<number | undefined> {
  const bridge = bridgeForWorkspace(host.env, host.workspaceId);
  if (!bridge || !readSettings(host).catalogId) return undefined;
  const auth = await verifiedAuth(host);
  if (!auth) return undefined;
  let pass = readPass(host);
  if (!pass || now - pass.started > PASS_MAX_AGE_MS) {
    pass = { id: now, cursor: null, seen: 0, started: now };
    putState(host, PASS_KEY, JSON.stringify(pass));
    await ensureCommerce(host, auth).catch(() => undefined); // never blocks the sync: its own failure is recorded and alerted
  }
  await settleBatches(host, auth);
  const profile = await bridge.getStoreProfile(host.workspaceId);
  const preferArabic = profile.ok ? profile.value.locale === 'ar' : true;
  const requests: CatalogRequest[] = [];
  const commits: (() => void)[] = [];
  let excluded = 0;
  let done = false;
  for (let page = 0; page < RECONCILE_PAGES_PER_RUN; page++) {
    const res = await bridge.listCatalog(host.workspaceId, pass.cursor, CATALOG_PAGE);
    if (!res.ok) throw new Error(`catalog read from the Store failed: ${res.reason}`);
    const planned = plan(host, res.value.items, preferArabic, pass.id, now);
    commits.push(planned.commit);
    requests.push(...planned.requests);
    excluded += planned.excluded;
    pass = { ...pass, cursor: res.value.nextCursor, seen: pass.seen + res.value.items.length };
    if (!pass.cursor) { done = true; break; }
  }
  await send(host, auth, requests);
  host.storage.transactionSync(() => { for (const c of commits) c(); }); // the ledger follows what Meta accepted
  putState(host, PASS_KEY, JSON.stringify(pass));
  if (!done) {
    console.log(JSON.stringify({ audit: 'catalog_reconcile_progress', workspace: host.workspaceId, sent: requests.length, seen: pass.seen }));
    return now + CATALOG_RETRY_MS;
  }
  const have = await listRetailerIds(auth);
  if (!have.ok) throw new Error(`catalog list from Meta failed: ${have.message}`);
  // Wanted = what the Store sells AND we put in: an item we exclude that Meta still holds (an old push, a lost DELETE) is an extra (WA-CAT-5).
  const wanted = new Set(host.sql.exec<{ retailer_id: string }>("SELECT retailer_id FROM catalog_items WHERE pass = ? AND status != 'excluded'", pass.id).toArray().map((r) => r.retailer_id));
  let extras = pass.seen ? have.value.filter((id) => !wanted.has(id)) : [];
  // A wrong catalog, a half-read Store list or a bug must not be able to empty a live catalog in one automatic run.
  if (!opts.allowMassDelete && extras.length > MASS_DELETE_MIN && extras.length > have.value.length * MASS_DELETE_SHARE) {
    alert('catalog_mass_delete_refused', { workspace: host.workspaceId, extras: extras.length, inCatalog: have.value.length });
    extras = [];
  }
  const closing: CatalogRequest[] = extras.map((id) => ({ method: 'DELETE', data: { id } }));
  await send(host, auth, closing);
  host.storage.transactionSync(() => {
    // What the pass did not see is not in the Store any more.
    if (pass.seen) host.sql.exec('DELETE FROM catalog_items WHERE pass != ?', pass.id);
    host.sql.exec("DELETE FROM store_state WHERE key = ?", PASS_KEY);
    // Changes that were waiting before the pass began are covered by it (every product was read after they happened).
    host.sql.exec('DELETE FROM catalog_dirty WHERE updated_at <= ?', pass.started);
  });
  putState(host, LAST_SYNC_KEY, String(now));
  console.log(JSON.stringify({ audit: 'catalog_reconcile', workspace: host.workspaceId, sent: requests.length + closing.length, archived: extras.length, skipped: excluded }));
  return nextLocalHour(now + 3_600_000, RECONCILE_HOUR_LOCAL, BACKUP_TIME_ZONE);
}
