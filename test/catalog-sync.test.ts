import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogRow } from '../src/core/store-bridge';
import { FakeStore } from './helpers/fake-store';
import type { GraphCall, GraphReply } from './helpers/graph';
import { apiFor, graphStub, useApiKey } from './helpers/api';
import { deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000044${String(n).padStart(2, '0')}`;
const CAT = '1234567890';
useApiKey();
const link = useStoreLink();

/** Which catalogs Meta says are connected to each WABA (default: this test's catalog on the workspace's WABA). */
let catalogsByWaba: Record<string, string[]> = {};
/** Stubs Graph: answers /{waba}/product_catalogs from catalogsByWaba, everything else from `responder`. */
function stubGraph(responder?: (call: GraphCall, n: number) => GraphReply, opts: { delayMs?: number; before?: (call: GraphCall) => Promise<void> | void } = {}) {
  let n = 0;
  return graphStub((call) => {
    const m = /\/(waba-[^/]+)\/product_catalogs/.exec(call.url);
    if (m) return { status: 200, json: { data: (catalogsByWaba[m[1]!] ?? [CAT]).map((id) => ({ id })) } };
    return responder ? responder(call, ++n) : { status: 200, json: { messages: [{ id: `wamid.out${++n}` }] } };
  }, opts.delayMs, opts.before);
}
beforeEach(() => { catalogsByWaba = {}; });
const batches = (calls: GraphCall[]) => calls.filter((c) => c.url.endsWith('/items_batch')).map((c) => c.body as { item_type: string; allow_upsert: boolean; requests: { method: string; data: Record<string, unknown> }[] });
const up = (ws: string, productId: string, variantIds: string[], at = Date.now(), deleted = false) =>
  storeEvent(ws, deleted ? 'catalog.product_deleted' : 'catalog.product_upserted', { productId, variantIds, updatedAt: iso(at) });
const later = () => Date.now() + 60_000;

async function configured(ws: string, catalogId: string | null = CAT) {
  await storeWorkspace(ws, { templates: false });
  if (catalogId) await workspace(ws).setStoreLinkSettings({ catalogId }, { catalogWabaId: 'waba-1' });
  // the first full reconcile that configuring schedules is not what these tests are about
  await exec(ws, "DELETE FROM scheduled_tasks WHERE kind = 'catalog_reconcile'");
}

describe('catalog sync (events)', () => {
  it('pushes a changed product as a feed item with the Store\'s price, stock and link', async () => {
    const ws = W(1);
    await configured(ws);
    const g = stubGraph();
    await deliver([up(ws, 'p3', ['v3'])]);
    expect((await workspace(ws).runDueTasks(Date.now())).ran).toBe(0); // inside the 30 s debounce
    await workspace(ws).runDueTasks(later());
    const [b] = batches(g.calls);
    expect(g.calls.find((c) => c.method === 'POST')!.url).toBe(`https://graph.facebook.com/v25.0/${CAT}/items_batch`);
    expect(b).toMatchObject({ item_type: 'PRODUCT_ITEM', allow_upsert: true });
    expect(b!.requests).toEqual([{
      method: 'UPDATE',
      data: { id: 'v3', title: 'Item 3 (ع)', description: 'Item 3 description', availability: 'in stock', condition: 'new', price: '110.00 EGP', image_link: 'https://img.example/v3.jpg', item_group_id: 'p3', link: 'https://shop.example/p/p3', brand: 'Brand' },
    }]);
    expect(link.fake.lastCall('getProducts')).toEqual([ws, ['p3', 'v3']]); // retailer ids: the product's own and its variants'
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_sync'")).toEqual([]);
  });

  it('coalesces a burst of changes into one Meta call, and archives a deleted product\'s variants', async () => {
    const ws = W(2);
    await configured(ws);
    const g = stubGraph();
    await deliver([up(ws, 'p1', ['v1']), up(ws, 'p2', ['v2']), up(ws, 'p4', ['v4a', 'v4b'], Date.now(), true)]);
    await workspace(ws).runDueTasks(later());
    const all = batches(g.calls);
    expect(all).toHaveLength(1);
    expect(all[0]!.requests.map((r) => [r.method, r.data.id])).toEqual([['UPDATE', 'v1'], ['UPDATE', 'v2'], ['DELETE', 'v4a'], ['DELETE', 'v4b']]);
  });

  it('keeps the change and retries with backoff when Meta rejects an item (HTTP 200 with a validation error)', async () => {
    const ws = W(3);
    await configured(ws);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const g = stubGraph((): GraphReply => (++n === 1 ? { status: 200, json: { validation_status: [{ errors: [{ message: 'Can not find required field id' }] }] } } : { status: 200, json: { handles: ['h'] } }));
    await deliver([up(ws, 'p5', ['v5'])]);
    const first = await workspace(ws).runDueTasks(later());
    expect(first.failed).toBe(1);
    expect(await rows(ws, 'SELECT product_id FROM catalog_dirty')).toEqual([{ product_id: 'p5' }]);
    const [t] = await rows<{ attempts: number; last_error: string }>(ws, "SELECT attempts, last_error FROM scheduled_tasks WHERE kind = 'catalog_sync'");
    expect(t).toMatchObject({ attempts: 1, last_error: expect.stringContaining('Can not find required field id') });
    await workspace(ws).runDueTasks(later() + 3_600_000);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
    expect(batches(g.calls)).toHaveLength(2);
  });

  it('a change that lands while a sync is in flight is not lost', async () => {
    const ws = W(4);
    await configured(ws);
    // Hold the first items_batch call open and deliver p2 while it is in flight: a sleep cannot promise that under load.
    // Plain flags, each side polling on its own timer: no promise crosses between the test and the Durable Object.
    let inBatch = false;
    let released = false;
    const g = stubGraph(undefined, {
      before: async (c: GraphCall) => {
        if (!c.url.endsWith('/items_batch') || released) return;
        inBatch = true;
        while (!released) await new Promise((r) => setTimeout(r, 5));
      },
    });
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    const stub = workspace(ws);
    const running = stub.runDueTasks(later());
    await vi.waitFor(() => expect(inBatch).toBe(true));
    await deliver([up(ws, 'p2', ['v2'], Date.now() + 1)]); // arrives mid-run
    released = true;
    await running;
    // the run saw p1 only; p2 must still be pending and have a task
    expect(await rows(ws, 'SELECT product_id FROM catalog_dirty')).toEqual([{ product_id: 'p2' }]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_sync'")).toHaveLength(1);
    await stub.runDueTasks(later() + 120_000);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
    expect(batches(g.calls).flatMap((b) => b.requests.map((r) => r.data.id))).toEqual(['v1', 'v2']);
  });

  it('does nothing and keeps the rows while no catalog is configured, and schedules a reconcile once it is', async () => {
    const ws = W(5);
    await configured(ws, null);
    const g = stubGraph();
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    expect(g.calls).toHaveLength(0); // no catalog configured: not even a verification call
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toHaveLength(1);
    await workspace(ws).setStoreLinkSettings({ catalogId: CAT }, { catalogWabaId: 'waba-1' });
    const [r] = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'catalog_reconcile'");
    expect(r!.due_at).toBeLessThan(Date.now() + 60_000);
  });

  it('skips an item with no image (Meta would refuse it) instead of failing the batch', async () => {
    const catalog: CatalogRow[] = [{ retailerId: 'v1', productId: 'p1', title: 'No picture', titleAr: null, description: null, priceMinor: 100, currency: 'EGP', availability: 'out_of_stock', imageUrl: null, link: 'https://s/p1', brand: null }];
    link.fake = new FakeStore('*', { catalog });
    const ws = W(6);
    await configured(ws);
    const g = stubGraph();
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    // never an upsert Meta would refuse; only a (harmless) DELETE in case an older push left the item there (WA-CAT-5)
    expect(batches(g.calls).flatMap((b) => b.requests.map((r) => r.method))).toEqual(['DELETE']);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]);
  });
});

describe('nightly reconcile', () => {
  const listing = (ids: string[], pageSize = 20) => (call: GraphCall): GraphReply => {
    if (call.method === 'POST') return { status: 200, json: { handles: ['h'] } };
    const after = Number(new URL(call.url).searchParams.get('after') ?? 0);
    const slice = ids.slice(after, after + pageSize);
    const next = after + pageSize < ids.length ? `https://graph.facebook.com/v25.0/${CAT}/products?fields=retailer_id&limit=100&after=${after + pageSize}` : undefined;
    return { status: 200, json: { data: slice.map((retailer_id) => ({ retailer_id })), ...(next ? { paging: { next } } : {}) } };
  };

  it('re-sends the whole Store catalog and archives what only Meta has', async () => {
    const ws = W(10);
    await configured(ws);
    const metaIds = [...Array.from({ length: 23 }, (_, i) => `v${i + 1}`), 'old-1', 'old-2'];
    const g = stubGraph(listing(metaIds));
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
    const sent = batches(g.calls).flatMap((b) => b.requests);
    expect(sent.filter((r) => r.method === 'UPDATE')).toHaveLength(23);
    expect(sent.filter((r) => r.method === 'DELETE').map((r) => r.data.id)).toEqual(['old-1', 'old-2']);
    expect(g.calls.filter((c) => c.url.includes('/products?'))).toHaveLength(2); // two pages of Meta's list
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toEqual([]); // covered by the full pass
    const [next] = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'catalog_reconcile'");
    expect(next!.due_at).toBeGreaterThan(Date.now() + 3_000_000); // rescheduled for the next night
  });

  it('never archives anything when the Store answers an empty catalog', async () => {
    link.fake = new FakeStore('*', { catalog: [] });
    const ws = W(11);
    await configured(ws);
    const g = stubGraph(listing(['a', 'b']));
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
    expect(batches(g.calls)).toEqual([]);
  });

  it('never follows a paging link that leaves Graph (the token would go with it)', async () => {
    const ws = W(12);
    await configured(ws);
    const g = stubGraph((call) => (call.method === 'POST' ? { status: 200, json: {} } : { status: 200, json: { data: [{ retailer_id: 'v1' }], paging: { next: 'https://evil.example/steal' } } }));
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
    expect(g.calls.every((c) => c.url.startsWith('https://graph.facebook.com/'))).toBe(true);
  });

  it('is scheduled when the store is linked, and nightly after the backup', async () => {
    const ws = W(13);
    await configured(ws);
    await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' })]);
    const [r] = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'catalog_reconcile'");
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(r!.due_at));
    expect(hour).toBe(3);
  });
});

describe('a catalog id is only used while it is provably this business\'s', () => {
  const posts = (g: ReturnType<typeof stubGraph>) => g.calls.filter((c) => c.method === 'POST');

  it('(a) refuses to save a catalog id that Meta does not list for the workspace\'s WABA, and writes nothing', async () => {
    const ws = W(20);
    const api = await apiFor(ws, 'owner');
    catalogsByWaba = { 'waba-1': ['999999999'] };
    const g = stubGraph();
    const res = await api.call('PATCH', '/store-link/settings', { catalogId: CAT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'catalog_not_linked' });
    expect(posts(g)).toEqual([]);
    expect((await (await api.call('GET', '/store-link/settings')).json() as { catalogId: unknown }).catalogId).toBeNull();
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_reconcile'")).toEqual([]);
  });

  it('(b) refuses a catalog that belongs to another business\'s WABA', async () => {
    const ws = W(21);
    const api = await apiFor(ws, 'owner');
    catalogsByWaba = { 'waba-1': [], 'waba-other': [CAT] };
    const g = stubGraph();
    expect((await api.call('PATCH', '/store-link/settings', { catalogId: CAT })).status).toBe(400);
    expect(g.calls.map((c) => c.url)).toEqual([expect.stringContaining('/waba-1/product_catalogs')]); // only ever asked about OUR WABA
  });

  it('saves a verified catalog id together with the WABA it was verified against, and the Durable Object refuses an unverified one', async () => {
    const ws = W(22);
    const api = await apiFor(ws, 'owner');
    stubGraph();
    expect((await api.call('PATCH', '/store-link/settings', { catalogId: CAT })).status).toBe(200);
    expect(await rows(ws, "SELECT value FROM store_state WHERE key = 'catalog.waba'")).toEqual([{ value: 'waba-1' }]);
    expect(await workspace(ws).setStoreLinkSettings({ catalogId: '5555555555' })).toEqual({ ok: false, reason: 'catalog_not_verified' });
    expect(await workspace(ws).getStoreLinkSettings()).toMatchObject({ catalogId: CAT });
  });

  it('(c) a reconcile that would archive half of the catalog archives nothing and alerts; an operator can lift the limit', async () => {
    link.fake = new FakeStore('*', { catalog: Array.from({ length: 50 }, (_, i) => ({ retailerId: `v${i + 1}`, productId: `p${i + 1}`, title: `T${i}`, titleAr: null, description: null, priceMinor: 100, currency: 'EGP', availability: 'in_stock' as const, imageUrl: 'https://i/x.jpg', link: 'https://s/x', brand: null })) });
    const ws = W(23);
    await configured(ws);
    const meta = [...Array.from({ length: 50 }, (_, i) => `v${i + 1}`), ...Array.from({ length: 50 }, (_, i) => `gone-${i}`)];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listing = (call: GraphCall): GraphReply => (call.method === 'POST' ? { status: 200, json: {} } : { status: 200, json: { data: meta.map((retailer_id) => ({ retailer_id })) } });
    const g = stubGraph(listing);
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
    expect(batches(g.calls).flatMap((b) => b.requests).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(batches(g.calls).flatMap((b) => b.requests).filter((r) => r.method === 'UPDATE')).toHaveLength(50);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('catalog_mass_delete_refused'));
    await workspace(ws).reconcileCatalog({ allowMassDelete: true });
    expect(batches(g.calls).flatMap((b) => b.requests).filter((r) => r.method === 'DELETE')).toHaveLength(50);
  });

  it('a small clean-up (10 items or fewer, or under 20%) still goes through on its own', async () => {
    const ws = W(24);
    await configured(ws);
    const meta = [...Array.from({ length: 23 }, (_, i) => `v${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `gone-${i}`)];
    const g = stubGraph((call) => (call.method === 'POST' ? { status: 200, json: {} } : { status: 200, json: { data: meta.map((retailer_id) => ({ retailer_id })) } }));
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
    expect(batches(g.calls).flatMap((b) => b.requests).filter((r) => r.method === 'DELETE')).toHaveLength(4);
  });

  it('re-verifies before every run: a catalog that is no longer connected is not written to (reconcile or event sync)', async () => {
    const ws = W(25);
    await configured(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    catalogsByWaba = { 'waba-1': [] }; // disconnected (or re-pointed) after it was saved
    const g = stubGraph();
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(later());
    expect(posts(g)).toEqual([]);
    expect(g.calls.some((c) => c.url.includes('/products?'))).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('catalog_not_linked'));
  });

  it('a workspace that no longer owns a number on the verified WABA cannot use the saved catalog', async () => {
    const ws = W(26);
    await configured(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = await import('cloudflare:test');
    await env.DB.prepare("UPDATE phone_numbers SET waba_id = 'waba-moved' WHERE workspace_id = ?").bind(ws).run();
    const g = stubGraph();
    await deliver([up(ws, 'p1', ['v1'])]);
    await workspace(ws).runDueTasks(later());
    expect(g.calls).toEqual([]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('waba_not_owned'));
  });

  it('a Meta outage while verifying retries instead of deciding anything', async () => {
    const ws = W(27);
    await configured(ws);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = graphStub(() => ({ status: 503, json: { error: { message: 'down' } } }));
    await deliver([up(ws, 'p1', ['v1'])]);
    const r = await workspace(ws).runDueTasks(later());
    expect(r.failed).toBe(1);
    expect(posts(g)).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toHaveLength(1);
  });
});
