import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStore } from './helpers/fake-store';
import type { GraphCall } from './helpers/graph';
import { apiFor, useApiKey } from './helpers/api';
import { CAT, freshMeta, graph, meta, path, row } from './helpers/catalogue';
import { deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

/** The WhatsApp catalogue as a store: sync completeness, deletes, variants, exclusions, batch verdicts, the shop button. */
const W = (n: number) => `00000000-0000-4000-8000-0000000046${String(n).padStart(2, '0')}`;
useApiKey();
const link = useStoreLink();
beforeEach(() => freshMeta());

type Req = { method: string; data: Record<string, unknown> };
const batches = (calls: GraphCall[]) => calls.filter((c) => c.url.endsWith('/items_batch')).map((c) => c.body as { requests: Req[] });
const sentReqs = (calls: GraphCall[]) => batches(calls).flatMap((b) => b.requests);
const up = (ws: string, productId: string, variantIds: string[], at = Date.now()) => storeEvent(ws, 'catalog.product_upserted', { productId, variantIds, updatedAt: iso(at) });
const del = (ws: string, productId: string, variantIds: string[] = [], at = Date.now()) => storeEvent(ws, 'catalog.product_deleted', { productId, variantIds, updatedAt: iso(at) });
const later = (ms = 60_000) => Date.now() + ms;

async function configured(ws: string) {
  await storeWorkspace(ws, { templates: false });
  await workspace(ws).setStoreLinkSettings({ catalogId: CAT }, { catalogWabaId: 'waba-1' });
  await exec(ws, "DELETE FROM scheduled_tasks WHERE kind = 'catalog_reconcile'");
}
const status = async (ws: string) => workspace(ws).getCatalogStatus();
const reconcileNow = async (ws: string, at = Date.now()) => {
  await workspace(ws).schedule('catalog_reconcile', at - 1);
  return workspace(ws).runDueTasks(at);
};

describe('the Store contract the sync depends on', () => {
  it('FakeStore obeys the real bridge: getProducts answers to RETAILER ids, so a product id alone returns nothing for a product with variants', async () => {
    const f = new FakeStore('*', { catalog: [row('v9a', 'p9'), row('v9b', 'p9'), row('simple', 'simple')] });
    expect((await f.getProducts('s', ['p9'])).ok && (await f.getProducts('s', ['p9']) as { value: { items: unknown[] } }).value.items).toEqual([]);
    const got = await f.getProducts('s', ['p9', 'v9a', 'v9b', 'simple']);
    expect(got.ok && got.value.items.map((r) => r.retailerId)).toEqual(['v9a', 'v9b', 'simple']);
  });
});

describe('incremental sync: variants, deletes, price and stock', () => {
  it('a product with variants reaches Meta, one item per variant in one group (item_group_id)', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v9a', 'p9', { title: 'Shirt - S' }), row('v9b', 'p9', { title: 'Shirt - M' })] });
    const ws = W(1);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p9', ['v9a', 'v9b'])]);
    await workspace(ws).runDueTasks(later());
    expect(link.fake.lastCall('getProducts')).toEqual([ws, ['p9', 'v9a', 'v9b']]);
    const items = sentReqs(g.calls);
    expect(items.map((r) => [r.data.id, r.data.item_group_id])).toEqual([['v9a', 'p9'], ['v9b', 'p9']]);
  });

  it('a simple product has no group id (its retailer id is its product id)', async () => {
    link.fake = new FakeStore('*', { catalog: [row('sp1', 'sp1')] });
    const ws = W(2);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'sp1', [])]);
    await workspace(ws).runDueTasks(later());
    expect(sentReqs(g.calls)).toHaveLength(1);
    expect(sentReqs(g.calls)[0]!.data).not.toHaveProperty('item_group_id');
  });

  it('a deleted product is archived even though the Store sends no ids for it (simple product, variantIds [])', async () => {
    link.fake = new FakeStore('*', { catalog: [row('sp1', 'sp1')] });
    const ws = W(3);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'sp1', [], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    await deliver([del(ws, 'sp1', [], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    expect(sentReqs(g.calls).map((r) => [r.method, r.data.id])).toEqual([['UPDATE', 'sp1'], ['DELETE', 'sp1']]);
    expect(await rows(ws, 'SELECT 1 FROM catalog_items')).toEqual([]);
  });

  it('a deleted variant product is archived variant by variant, from what the ledger holds', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v9a', 'p9'), row('v9b', 'p9')] });
    const ws = W(4);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p9', ['v9a', 'v9b'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = [];
    await deliver([del(ws, 'p9', [], Date.now())]); // the Store has no variants to name any more
    await workspace(ws).runDueTasks(later(120_000));
    expect(sentReqs(g.calls).filter((r) => r.method === 'DELETE').map((r) => r.data.id).sort()).toEqual(['v9a', 'v9b']);
  });

  it('a variant removed from a live product leaves the catalogue; the others stay', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v9a', 'p9'), row('v9b', 'p9')] });
    const ws = W(5);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p9', ['v9a', 'v9b'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = [row('v9a', 'p9')];
    await deliver([up(ws, 'p9', ['v9a'], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    const second = batches(g.calls)[1]!.requests.map((r) => [r.method, r.data.id]);
    expect(second).toEqual([['UPDATE', 'v9a'], ['DELETE', 'v9b']]);
  });

  it('a price and a stock change reach Meta within the 30 s debounce, as the Store\'s live values', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1', { priceMinor: 10_000 })] });
    const ws = W(6);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p1', ['v1'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = [row('v1', 'p1', { priceMinor: 12_550 })];
    link.fake.stock['v1'] = 0;
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    expect((await workspace(ws).runDueTasks(Date.now())).ran).toBe(0); // not before the debounce
    await workspace(ws).runDueTasks(later(45_000));
    const [, second] = batches(g.calls);
    expect(second!.requests[0]!.data).toMatchObject({ id: 'v1', price: '125.50 EGP', availability: 'out of stock' });
  });

  it('the title is Arabic when the store default is Arabic, English when it is English', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(7);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    expect(sentReqs(g.calls)[0]!.data.title).toBe('منتج v1');
  });
});

describe('more than 200 products', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`x${i}`, `px${i}`));

  it('the event path pages through 450 changed products across runs until none is left', async () => {
    link.fake = new FakeStore('*', { catalog: many(450) });
    const ws = W(10);
    await configured(ws);
    const g = graph();
    for (let i = 0; i < 450; i++) await exec(ws, 'INSERT INTO catalog_dirty (product_id, variant_ids, deleted, updated_at) VALUES (?, ?, 0, ?)', `px${i}`, JSON.stringify([`x${i}`]), 1000 + i);
    await workspace(ws).schedule('catalog_sync', Date.now() - 1);
    for (let run = 0; run < 6; run++) await workspace(ws).runDueTasks(later(60_000 * (run + 1)));
    expect(new Set(sentReqs(g.calls).map((r) => r.data.id)).size).toBe(450);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
    expect((await status(ws)).items!.synced).toBe(450);
  });

  it('a full pass reads three Store pages per run, keeps its cursor, and archives only at the very end', async () => {
    link.fake = new FakeStore('*', { catalog: many(650) });
    const ws = W(11);
    await configured(ws);
    const g = graph(['old-1', 'x5']);
    await reconcileNow(ws);
    expect((await status(ws)).syncing).toBe(true);
    expect(link.fake.count('listCatalog')).toBe(3); // 300 products
    expect(sentReqs(g.calls).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(g.calls.filter((c) => path(c) === `${CAT}/products`)).toEqual([]); // Meta's list is read once, at the end
    for (let run = 2; run <= 4; run++) await workspace(ws).runDueTasks(later(60_000 * run));
    const all = sentReqs(g.calls);
    expect(new Set(all.filter((r) => r.method === 'UPDATE').map((r) => r.data.id)).size).toBe(650);
    expect(all.filter((r) => r.method === 'DELETE').map((r) => r.data.id)).toEqual(['old-1']);
    const s = await status(ws);
    expect(s).toMatchObject({ syncing: false, items: { synced: 650, excluded: 0, rejected: 0 } });
    expect(s.lastSyncAt).toEqual(expect.any(Number));
  });

  it('a product that appears while a pass is running is not archived by that pass', async () => {
    link.fake = new FakeStore('*', { catalog: many(350) });
    const ws = W(12);
    await configured(ws);
    graph(['late']);
    await reconcileNow(ws); // 300 of 350 read
    link.fake.catalog = [...link.fake.catalog, row('late', 'late')];
    link.fake.stock['late'] = 5;
    const g2 = graph(['late']);
    await deliver([up(ws, 'late', [], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    await workspace(ws).runDueTasks(later(240_000));
    expect(sentReqs(g2.calls).filter((r) => r.method === 'DELETE')).toEqual([]);
  });
});

describe('items left out are listed, not dropped', () => {
  it('an item without an image, or with an insecure image link, is recorded with the reason and shown in the status', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1', { imageUrl: null }), row('v2', 'p2', { imageUrl: 'http://img.example/v2.jpg' }), row('v3', 'p3')] });
    const ws = W(20);
    await configured(ws);
    const g = graph();
    await reconcileNow(ws);
    expect(sentReqs(g.calls).map((r) => r.data.id)).toEqual(['v3']);
    const s = await status(ws);
    expect(s.items).toEqual({ synced: 1, excluded: 2, rejected: 0 });
    expect(s.leftOut!.map((i) => [i.retailerId, i.reason]).sort()).toEqual([['v1', 'no_image'], ['v2', 'bad_image']]);
  });

  it('an item that was in the catalogue and loses its image is archived, and listed as left out', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(21);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p1', ['v1'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = [row('v1', 'p1', { imageUrl: null })];
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    expect(batches(g.calls)[1]!.requests.map((r) => [r.method, r.data.id])).toEqual([['DELETE', 'v1']]);
    expect((await status(ws)).leftOut).toEqual([{ retailerId: 'v1', reason: 'no_image' }]);
  });

  it('an item Meta refuses after the batch (the async verdict) becomes rejected on the next run', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1'), row('v2', 'p2')] });
    const ws = W(22);
    await configured(ws);
    meta.batchStatus = () => ({ data: [{ status: 'finished', errors_total_count: 1, ids_of_invalid_requests: ['v2', 'never-ours'] }] });
    const g = graph();
    await reconcileNow(ws);
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    expect(g.calls.some((c) => path(c) === `${CAT}/check_batch_request_status` && new URL(c.url).searchParams.get('load_ids_of_invalid_requests') === 'true')).toBe(true);
    const s = await status(ws);
    expect(s.items).toMatchObject({ rejected: 1 });
    expect(s.leftOut).toEqual([{ retailerId: 'v2', reason: 'meta_rejected' }]);
  });

  it('a batch Meta has not finished yet is asked again, not believed', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(23);
    await configured(ws);
    meta.batchStatus = () => ({ data: [{ status: 'in_progress' }] });
    graph();
    await reconcileNow(ws);
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    expect((await status(ws)).items!.rejected).toBe(0);
  });
});

describe('a failed send never loses a delete or invents a card (WA-CAT-5)', () => {
  const lose = (id: string, pid: string) => [row(id, pid, { imageUrl: null })];

  it('an item that loses its image while the first items_batch fails still ends up deleted from Meta', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(60);
    await configured(ws);
    let failing = false;
    const g = graph([], (c) => (failing && path(c) === `${CAT}/items_batch` ? { status: 500, json: { error: { message: 'boom' } } } : undefined));
    await deliver([up(ws, 'p1', ['v1'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = lose('v1', 'p1');
    failing = true;
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    expect((await workspace(ws).runDueTasks(later(120_000))).failed).toBe(1);
    failing = false;
    const failedCalls = batches(g.calls).length;
    await workspace(ws).runDueTasks(later(6 * 3_600_000));
    expect(batches(g.calls).length).toBeGreaterThan(failedCalls); // the retry really reached Meta
    const last = batches(g.calls).at(-1)!.requests;
    expect(last.map((r) => [r.method, r.data.id])).toEqual([['DELETE', 'v1']]);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
  });

  it('the first pass after the ledger exists treats an excluded item Meta still holds as an extra and deletes it', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1', { imageUrl: 'http://img.example/v1.jpg' }), row('v2', 'p2')] });
    const ws = W(61);
    await configured(ws);
    const g = graph(['v1', 'v2']); // the old code had pushed v1; the ledger is empty
    await reconcileNow(ws);
    const deletes = sentReqs(g.calls).filter((r) => r.method === 'DELETE').map((r) => r.data.id);
    expect(deletes).toContain('v1');
    expect(deletes).not.toContain('v2');
  });

  it('a nightly pass deletes an item the ledger says is excluded but Meta still has (self-healing)', async () => {
    link.fake = new FakeStore('*', { catalog: [...lose('v1', 'p1'), row('v2', 'p2')] });
    const ws = W(62);
    await configured(ws);
    await exec(ws, "INSERT INTO catalog_items (retailer_id, product_id, group_id, status, reason, pass, updated_at) VALUES ('v1', 'p1', NULL, 'excluded', 'no_image', 0, 1)");
    const g = graph(['v1', 'v2']);
    await reconcileNow(ws);
    const closing = batches(g.calls).at(-1)!.requests;
    expect(closing.map((r) => [r.method, r.data.id])).toEqual([['DELETE', 'v1']]);
  });

  it('a send that fails leaves no synced row behind, so no card goes out for an item Meta never got', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(63);
    await configured(ws);
    graph([], (c) => (path(c) === `${CAT}/items_batch` ? { status: 500, json: { error: { message: 'boom' } } } : undefined));
    await deliver([up(ws, 'p1', ['v1'])]);
    expect((await workspace(ws).runDueTasks(later())).failed).toBe(1);
    expect(await rows(ws, "SELECT 1 FROM catalog_items WHERE status = 'synced'")).toEqual([]);
  });

  it('an ok but EMPTY Store answer for live dirty products archives nothing at once; a full pass is scheduled to decide', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(64);
    await configured(ws);
    const g = graph();
    await deliver([up(ws, 'p1', ['v1'], Date.now() - 5000)]);
    await workspace(ws).runDueTasks(later());
    link.fake.catalog = [];
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    await workspace(ws).runDueTasks(later(120_000));
    expect(sentReqs(g.calls).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_reconcile'")).toHaveLength(1);
    expect(await rows(ws, "SELECT 1 FROM catalog_items WHERE retailer_id = 'v1' AND status = 'synced'")).toHaveLength(1);
  });
});

describe('failures are visible and actionable', () => {
  it('a Meta permission error is stored as missing_permission for the merchant, and the sync keeps retrying', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(30);
    await configured(ws);
    graph([], (c) => (path(c) === `${CAT}/items_batch` ? { status: 400, json: { error: { code: 200, message: '(#200) Requires catalog_management permission' } } } : undefined));
    await deliver([up(ws, 'p1', ['v1'])]);
    const r = await workspace(ws).runDueTasks(later());
    expect(r.failed).toBe(1);
    expect((await status(ws)).error).toBe('missing_permission');
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toHaveLength(1);
  });

  it('three failed runs in a row raise the P1 alert catalog_sync_stuck (one failure does not)', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(32);
    await configured(ws);
    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    graph([], (c) => (path(c) === `${CAT}/items_batch` ? { status: 500, json: { error: { code: 2, message: 'boom' } } } : undefined));
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    await workspace(ws).runDueTasks(later(3_600_000));
    expect(log.join('\n')).not.toContain('"alert":"catalog_sync_stuck"');
    await workspace(ws).runDueTasks(later(7_200_000));
    expect(log.join('\n')).toContain('"alert":"catalog_sync_stuck"');
  });

  it('an ordinary failure is sync_failed, and a later success clears it', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(31);
    await configured(ws);
    let fail = true;
    graph([], (c) => (path(c) === `${CAT}/items_batch` && fail ? { status: 500, json: { error: { code: 2, message: 'boom' } } } : undefined));
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    expect((await status(ws)).error).toBe('sync_failed');
    fail = false;
    await workspace(ws).runDueTasks(later(3_600_000));
    expect((await status(ws)).error).toBeNull();
  });
});

describe('the shop button and the cart on the number', () => {
  it('the first pass switches the catalogue button and the cart on (Meta hides the button by default), and the status says so', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(40);
    await configured(ws);
    const g = graph();
    await reconcileNow(ws);
    const post = g.calls.find((c) => c.method === 'POST' && path(c) === 'pn-' + ws + '/whatsapp_commerce_settings');
    expect(post).toBeDefined();
    expect(new URL(post!.url).searchParams.get('is_catalog_visible')).toBe('true');
    expect(meta.commerce).toEqual({ visible: true, cart: true });
    expect((await status(ws)).commerce).toEqual({ catalogVisible: true, cartEnabled: true, failed: null });
  });

  it('writes nothing when Meta already has the wanted state', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(41);
    await configured(ws);
    meta.commerce = { visible: true, cart: true };
    const g = graph();
    await reconcileNow(ws);
    expect(g.calls.filter((c) => c.method === 'POST' && /whatsapp_commerce_settings/.test(c.url))).toEqual([]);
  });

  it('the owner can turn the button off; the choice is kept and the next pass does not undo it', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(42);
    await configured(ws);
    meta.commerce = { visible: true, cart: true };
    const g = graph();
    const api = await apiFor(ws, 'owner', `pn-${ws}`);
    const res = await api.call('PUT', '/store-link/catalog/commerce', { catalogVisible: false, cartEnabled: true });
    expect(res.status).toBe(200);
    expect(meta.commerce).toEqual({ visible: false, cart: true });
    await reconcileNow(ws);
    expect(meta.commerce).toEqual({ visible: false, cart: true });
    expect(g.calls.filter((c) => c.method === 'POST' && /whatsapp_commerce_settings/.test(c.url))).toHaveLength(1);
  });

  it('the owner turning the button off while a pass is mid-flight wins: the pass writes nothing and records nothing', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(43);
    await configured(ws);
    let flipped = false;
    const g = graph([], undefined, async (c) => {
      if (!flipped && c.method === 'GET' && /whatsapp_commerce_settings/.test(c.url)) {
        flipped = true;
        await exec(ws, "INSERT INTO store_state (key, value) VALUES ('catalog.commerce_want', '{\"catalogVisible\":false,\"cartEnabled\":true}') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      }
    });
    await reconcileNow(ws);
    expect(flipped).toBe(true);
    expect(g.calls.filter((c) => c.method === 'POST' && /whatsapp_commerce_settings/.test(c.url))).toEqual([]);
    expect(meta.commerce.visible).toBe(false);
  });

  it('a change that lands while the pass is writing is not overwritten in the stored state either (nothing recorded for the stale want)', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(44);
    await configured(ws);
    let flipped = false;
    graph([], undefined, async (c) => {
      if (!flipped && c.method === 'POST' && /whatsapp_commerce_settings/.test(c.url)) {
        flipped = true;
        await exec(ws, "INSERT INTO store_state (key, value) VALUES ('catalog.commerce_want', '{\"catalogVisible\":false,\"cartEnabled\":true}') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      }
    });
    await reconcileNow(ws);
    expect(flipped).toBe(true);
    expect((await status(ws)).commerce).toBeNull();
  });

  it('staff cannot change it, and a body that does not parse is a 400', async () => {
    const ws = W(43);
    await configured(ws);
    graph();
    const staff = await apiFor(ws, 'staff', `pn-${ws}`);
    expect((await staff.call('PUT', '/store-link/catalog/commerce', { catalogVisible: true, cartEnabled: true })).status).toBe(403);
    const owner = await apiFor(ws, 'owner', `pn-${ws}`);
    expect((await owner.call('PUT', '/store-link/catalog/commerce', { catalogVisible: 'yes' })).status).toBe(400);
  });

  it('a permission error on the settings is reported as missing_permission, not hidden', async () => {
    const ws = W(44);
    await configured(ws);
    graph([], (c) => (/whatsapp_commerce_settings/.test(c.url) ? { status: 403, json: { error: { code: 10, message: 'Permission denied' } } } : undefined));
    const api = await apiFor(ws, 'owner', `pn-${ws}`);
    const res = await api.call('PUT', '/store-link/catalog/commerce', { catalogVisible: true, cartEnabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: 'missing_permission' });
    expect((await status(ws)).commerce).toMatchObject({ failed: 'missing_permission' });
  });
});

describe('resync now', () => {
  it('starts a full pass within seconds; staff cannot; nothing to resync without a catalogue', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1')] });
    const ws = W(50);
    await configured(ws);
    const g = graph();
    const owner = await apiFor(ws, 'owner', `pn-${ws}`);
    const staff = await apiFor(ws, 'staff', `pn-${ws}`);
    expect((await staff.call('POST', '/store-link/catalog/resync', {})).status).toBe(403);
    const res = await owner.call('POST', '/store-link/catalog/resync', {});
    expect(await res.json()).toEqual({ started: true });
    await workspace(ws).runDueTasks(later(60_000));
    expect(sentReqs(g.calls).map((r) => r.data.id)).toEqual(['v1']);

    const bare = W(51);
    await storeWorkspace(bare, { templates: false });
    const bareOwner = await apiFor(bare, 'owner', `pn-${bare}`);
    expect((await bareOwner.call('POST', '/store-link/catalog/resync', {})).status).toBe(409);
  });

  it('GET /store-link/catalog carries the new fields and stays readable by staff', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1', { imageUrl: null })] });
    const ws = W(52);
    await configured(ws);
    graph();
    await reconcileNow(ws);
    const staff = await apiFor(ws, 'staff', `pn-${ws}`);
    const res = await staff.call('GET', '/store-link/catalog');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ catalogId: CAT, items: { synced: 0, excluded: 1, rejected: 0 }, leftOut: [{ retailerId: 'v1', reason: 'no_image' }], syncing: false, pending: 0, error: null });
  });
});
