import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { GraphCall, GraphReply } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';
import { rows, seedNumber, workspace } from './helpers/workspace';
import { useStoreLink } from './helpers/store-link';

useApiKey();
useStoreLink();

const BIZ = '7700000001';
const NEW_CAT = '5550001111';
/** What Meta holds in this test: catalogs owned by the business, and those connected to the WABA. */
let owned: { id: string; name: string }[] = [];
let connected: string[] = [];
/** The WABAs Meta says the business owns (default: set per test by owner()). */
let wabasOfBiz: string[] = [];
beforeEach(() => { owned = []; connected = []; wabasOfBiz = []; });

const path = (c: GraphCall) => `${c.method} ${new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '')}`;
/** A Graph that behaves like Meta for the three catalog edges; `over` can replace the answer for one "METHOD path". */
function meta(over: Record<string, (c: GraphCall) => GraphReply> = {}) {
  return (c: GraphCall): GraphReply => {
    const key = path(c);
    const hit = over[key];
    if (hit) return hit(c);
    if (key === `POST ${BIZ}/owned_product_catalogs`) {
      owned.push({ id: NEW_CAT, name: c.body.name });
      return { status: 200, json: { id: NEW_CAT } };
    }
    if (key === `GET ${BIZ}/owned_whatsapp_business_accounts`) return { status: 200, json: { data: wabasOfBiz.map((id) => ({ id })) } };
    if (key === `GET ${BIZ}/owned_product_catalogs`) return { status: 200, json: { data: owned } };
    if (/^GET [^/]+\/product_catalogs$/.test(key)) return { status: 200, json: { data: connected.map((id) => ({ id })) } };
    if (/^POST [^/]+\/product_catalogs$/.test(key)) {
      connected.push(c.body.catalog_id);
      return { status: 200, json: { success: true } };
    }
    if (/^GET \d+\/products$/.test(key)) return { status: 200, json: { data: [] } };
    if (/^POST \d+\/items_batch$/.test(key)) return { status: 200, json: { handles: ['h'] } };
    return { status: 404, json: { error: { code: 100, message: `unstubbed ${key}` } } };
  };
}
const posts = (g: { calls: GraphCall[] }) => g.calls.map(path).filter((p) => p.startsWith('POST'));
const creates = (g: { calls: GraphCall[] }) => posts(g).filter((p) => p.endsWith('owned_product_catalogs'));

async function owner(n: number, businessId: string | null = BIZ) {
  const ws = W(n);
  wabasOfBiz = [`waba-${n}`];
  await seedOwnNumber(`pn-${n}`, ws, `waba-${n}`, 'biz-token');
  if (businessId) await env.DB.prepare('UPDATE waba_credentials SET business_id = ? WHERE waba_id = ?').bind(businessId, `waba-${n}`).run();
  return { ws, api: await apiFor(ws, 'owner', `pn-${n}`) };
}
const provision = (api: Awaited<ReturnType<typeof apiFor>>, body: unknown = {}) => api.call('POST', '/store-link/catalog/provision', body);
const saved = async (api: Awaited<ReturnType<typeof apiFor>>) => ((await (await api.call('GET', '/store-link/settings')).json()) as { catalogId: string | null }).catalogId;

describe('catalog provisioning', () => {
  it('creates the catalog, connects it to the WABA, saves it and schedules the first sync', async () => {
    const { ws, api } = await owner(6001);
    const g = graphStub(meta());
    const res = await provision(api, { name: 'متجر الورد' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ catalogId: NEW_CAT });
    const create = g.calls.find((c) => path(c) === `POST ${BIZ}/owned_product_catalogs`)!;
    expect(create.body).toEqual({ name: 'متجر الورد', vertical: 'commerce' });
    expect(create.headers.authorization).toBe('Bearer biz-token'); // the merchant's business token, never the platform's
    expect(g.calls.find((c) => path(c) === 'POST waba-6001/product_catalogs')!.body).toEqual({ catalog_id: NEW_CAT });
    expect(g.calls.every((c) => c.headers.authorization === 'Bearer biz-token')).toBe(true);
    expect(await saved(api)).toBe(NEW_CAT);
    expect(await rows(ws, "SELECT value FROM store_state WHERE key = 'catalog.waba'")).toEqual([{ value: 'waba-6001' }]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_reconcile'")).toHaveLength(1);
  });

  it('defaults the name to the Store\'s name', async () => {
    const { api } = await owner(6002);
    const g = graphStub(meta());
    expect((await provision(api)).status).toBe(200);
    expect(g.calls.find((c) => path(c) === `POST ${BIZ}/owned_product_catalogs`)!.body.name).toBe('متجر الاختبار');
  });

  it('a retry after a timeout between create and connect creates no second catalog', async () => {
    const { api } = await owner(6003);
    let failConnect = true;
    const g = graphStub(meta(), undefined, (c) => {
      if (failConnect && path(c) === 'POST waba-6003/product_catalogs') {
        failConnect = false;
        throw new Error('timeout');
      }
    });
    const first = await provision(api, { name: 'Shop' });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'rate_limited', message: 'meta_error', retryable: true });
    expect(await saved(api)).toBeNull();
    const second = await provision(api, { name: 'Shop' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ catalogId: NEW_CAT });
    expect(creates(g)).toHaveLength(1);
    expect(owned).toHaveLength(1);
    expect(await saved(api)).toBe(NEW_CAT);
  });

  it('a retry after the create ANSWER was lost finds the catalog by name instead of creating another', async () => {
    const { api } = await owner(6004);
    let lose = true;
    const g = graphStub(meta(), undefined, (c) => {
      if (lose && path(c) === `POST ${BIZ}/owned_product_catalogs`) {
        lose = false;
        // Meta created it, but the answer never reached us
        owned.push({ id: NEW_CAT, name: 'Shop' });
        throw new Error('timeout');
      }
    });
    expect((await provision(api, { name: 'Shop' })).status).toBe(503);
    const second = await provision(api, { name: 'Shop' });
    expect(second.status).toBe(200);
    expect(creates(g)).toHaveLength(1); // only the lost attempt
    expect(await saved(api)).toBe(NEW_CAT);
  });

  it('a missing permission is missing_permission, saves nothing and does not retry', async () => {
    const { ws, api } = await owner(6005);
    graphStub(meta({ [`POST ${BIZ}/owned_product_catalogs`]: () => ({ status: 403, json: { error: { code: 200, message: '(#200) Requires catalog_management permission' } } }) }));
    const res = await provision(api, { name: 'Shop' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'missing_permission' });
    expect(await saved(api)).toBeNull();
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key = 'catalog.provision'")).toEqual([]);
  });

  it('a workspace whose number has no recorded business answers no_business and calls Meta for nothing', async () => {
    const { api } = await owner(6006, null);
    const g = graphStub(meta());
    const res = await provision(api, { name: 'Shop' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'no_business' });
    expect(g.calls).toHaveLength(0);
  });

  it('staff cannot provision', async () => {
    const { ws } = await owner(6007);
    const staff = await apiFor(ws, 'staff', 'pn-6007');
    const g = graphStub(meta());
    expect((await provision(staff, { name: 'Shop' })).status).toBe(403);
    expect(g.calls).toHaveLength(0);
  });

  it('a catalog that is already set answers 409 and creates nothing', async () => {
    const { api } = await owner(6008);
    const g = graphStub(meta());
    expect((await provision(api, { name: 'Shop' })).status).toBe(200);
    const again = await provision(api, { name: 'Shop' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'invalid_request', message: 'catalog_already_set' });
    expect(creates(g)).toHaveLength(1);
  });

  it('rejects a body that does not parse', async () => {
    const { api } = await owner(6009);
    const g = graphStub(meta());
    expect((await provision(api, { name: '' })).status).toBe(400);
    expect((await provision(api, { name: 'x'.repeat(101) })).status).toBe(400);
    expect(g.calls).toHaveLength(0);
  });

  it('two requests at once create one catalog (the second is told to retry)', async () => {
    const { api } = await owner(6010);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const g = graphStub(meta(), undefined, async (c) => {
      if (path(c) === `POST ${BIZ}/owned_product_catalogs`) await gate;
    });
    const first = provision(api, { name: 'Shop' });
    await vi.waitFor(() => expect(creates(g)).toHaveLength(1));
    const second = await provision(api, { name: 'Shop' });
    expect(second.status).toBe(503);
    release();
    expect((await first).status).toBe(200);
    expect(creates(g)).toHaveLength(1);
  });

  it('GET /store-link/catalog shows the catalog id and the time of the last sync (null before the first)', async () => {
    const { ws, api } = await owner(6011);
    graphStub(meta());
    const status = async () => (await api.call('GET', '/store-link/catalog')).json();
    expect(await status()).toEqual({ catalogId: null, lastSyncAt: null });
    expect((await provision(api, { name: 'Shop' })).status).toBe(200);
    expect(await status()).toEqual({ catalogId: NEW_CAT, lastSyncAt: null });
    await workspace(ws).runDueTasks(Date.now() + 60_000); // the first full reconcile
    const after = (await status()) as { lastSyncAt: number | null };
    expect(after.lastSyncAt).toEqual(expect.any(Number));
  });

  it('the status is readable by staff', async () => {
    const { ws } = await owner(6012);
    const staff = await apiFor(ws, 'staff', 'pn-6012');
    expect((await staff.call('GET', '/store-link/catalog')).status).toBe(200);
  });

  it('uses only the merchant\'s own token: with no credential for the WABA it is refused and the platform token never leaves', async () => {
    const ws = W(6013);
    await seedNumber('pn-6013', ws); // a platform-style number: no waba_credentials row
    const g = graphStub(meta());
    const res = await workspace(ws).provisionCatalog({ name: 'Shop', wabaId: 'waba-1', businessId: BIZ });
    expect(res).toEqual({ ok: false, code: 'missing_permission', retryable: false });
    expect(g.calls.filter((c) => c.headers.authorization === 'Bearer test-token')).toEqual([]); // META_SYSTEM_TOKEN of the test env
    expect(g.calls).toHaveLength(0);
  });

  it('a business id forged in the request body is refused, nothing is called', async () => {
    const { api } = await owner(6014);
    const g = graphStub(meta());
    expect((await provision(api, { name: 'Shop', businessId: '999000999' })).status).toBe(400);
    expect(g.calls).toHaveLength(0);
  });

  it('refuses when the stored business does not own the WABA according to Meta, and creates nothing', async () => {
    const { ws, api } = await owner(6015);
    wabasOfBiz = ['waba-somebody-else'];
    const g = graphStub(meta());
    const res = await provision(api, { name: 'Shop' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'business_mismatch' });
    expect(creates(g)).toEqual([]);
    expect(g.calls.every((c) => c.headers.authorization === 'Bearer biz-token')).toBe(true);
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key = 'catalog.provision'")).toEqual([]);
  });
});
