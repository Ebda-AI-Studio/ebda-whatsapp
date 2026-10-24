import { describe, expect, it, vi } from 'vitest';
import type { CatalogRow } from '../src/core/store-bridge';
import { FakeStore } from './helpers/fake-store';
import { stubGraph, type GraphCall, type GraphReply } from './helpers/graph';
import { deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000044${String(n).padStart(2, '0')}`;
const CAT = '1234567890';
const link = useStoreLink();
const batches = (calls: GraphCall[]) => calls.filter((c) => c.url.endsWith('/items_batch')).map((c) => c.body as { item_type: string; allow_upsert: boolean; requests: { method: string; data: Record<string, unknown> }[] });
const up = (ws: string, productId: string, variantIds: string[], at = Date.now(), deleted = false) =>
  storeEvent(ws, deleted ? 'catalog.product_deleted' : 'catalog.product_upserted', { productId, variantIds, updatedAt: iso(at) });
const later = () => Date.now() + 60_000;

async function configured(ws: string, catalogId: string | null = CAT) {
  await storeWorkspace(ws, { templates: false });
  if (catalogId) await workspace(ws).setStoreLinkSettings({ catalogId });
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
    expect(g.calls[0]!.url).toBe(`https://graph.facebook.com/v25.0/${CAT}/items_batch`);
    expect(b).toMatchObject({ item_type: 'PRODUCT_ITEM', allow_upsert: true });
    expect(b!.requests).toEqual([{
      method: 'UPDATE',
      data: { id: 'v3', title: 'Item 3 (ع)', description: 'Item 3 description', availability: 'in stock', condition: 'new', price: '110.00 EGP', image_link: 'https://img.example/v3.jpg', link: 'https://shop.example/p/p3', brand: 'Brand' },
    }]);
    expect(link.fake.lastCall('getProducts')).toEqual([ws, ['p3']]);
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
    const g = stubGraph(undefined, { delayMs: 40 });
    await deliver([up(ws, 'p1', ['v1'], Date.now())]);
    const stub = workspace(ws);
    const running = stub.runDueTasks(later());
    await new Promise((r) => setTimeout(r, 15));
    await deliver([up(ws, 'p2', ['v2'], Date.now() + 1)]); // arrives mid-run
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
    expect(g.calls).toHaveLength(0);
    expect(await rows(ws, 'SELECT 1 FROM catalog_dirty')).toHaveLength(1);
    await workspace(ws).setStoreLinkSettings({ catalogId: CAT });
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
    expect(batches(g.calls)).toEqual([]);
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
    expect(g.calls.filter((c) => c.method === 'GET')).toHaveLength(2); // two pages of Meta's list
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
