/** Final-review fixes I3 (a non-member super admin must use view-as on EVERY store route) and I4 (the view log stores the routed pattern and keyed param hashes, never a raw path). */
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/index';
import { configureSessionCheck } from '../src/core/identity/session';
import { subjectHash } from '../src/core/erasure';
import { OP1, adminToken, apiFor, storeId as W0, useApiKey } from './helpers/api';
import { own } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => configureSessionCheck(null));
const W = (n: number) => W0(9500 + n);
const REASON = 'merchant asked why campaigns are paused (ticket 123)';
const get = async (ws: string, path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://x/api/v1/stores/${ws}${path}`, { headers: { authorization: `Bearer ${await adminToken(OP1)}`, ...headers } });
const asView = (ws: string, path: string) => get(ws, path, { 'x-view-as-merchant': '1', 'x-view-as-reason': REASON });
const log = (ws: string) => env.DB.prepare('SELECT route, params FROM operator_view_log WHERE workspace_id = ? ORDER BY id').bind(ws).all<{ route: string; params: string | null }>().then((r) => r.results);

describe('I3 a non-member super admin reads store routes only through view-as', () => {
  it('WALK: every registered store GET route is 403 view_as_required without the header; members are unaffected', async () => {
    const ws = W(1);
    await own(ws);
    const gets = apiRoutes.routes.filter((r) => r.method === 'GET' && r.path.startsWith('/stores/:storeId'));
    expect(gets.length).toBeGreaterThan(30);
    const open: string[] = [];
    for (const r of gets) {
      const path = r.path.replace('/stores/:storeId', '').replace(/:[A-Za-z]+(\{[^}]*\})?/g, '1');
      const res = await get(ws, path);
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.status !== 403 || body.message !== 'view_as_required') open.push(`GET ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
    expect(await log(ws)).toEqual([]); // nothing was served, so nothing is in the view log
    const owner = await apiFor(ws);
    expect((await owner.call('GET', '/conversations')).status).toBe(200);
  });
  it('with the header and a reason the read is served and logged (the old behaviour of view-as)', async () => {
    const ws = W(2);
    await apiFor(ws);
    expect((await asView(ws, '/conversations')).status).toBe(200);
    expect(await log(ws)).toHaveLength(1);
  });
});

describe('I4 the view log keeps the routed pattern and keyed hashes of the route params', () => {
  const ENCODED = '%2B201001234567';
  const INDIC = '٢٠١٠٠١٢٣٤٥٦٧';
  const DASHED = '20-100-123-4567';
  it('the three spellings that used to slip through store no phone-like text, and the same person has ONE hash', async () => {
    const ws = W(3);
    await apiFor(ws);
    for (const wa of [ENCODED, INDIC, DASHED, '201001234567']) await asView(ws, `/contacts/${wa}/orders`);
    const rows = await log(ws);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.route).toBe('/stores/:storeId/contacts/:waId/orders');
      expect(r.route).not.toMatch(/\d{6,}/);
      const params = JSON.parse(r.params!) as Record<string, string>;
      expect(Object.keys(params).sort()).toEqual(['storeId', 'waId']);
      for (const v of Object.values(params)) expect(v).toMatch(/^[0-9a-f]{32}$/);
      expect(r.params).not.toMatch(/2010|20-100|٢٠١/);
    }
    const waHashes = new Set(rows.map((r) => (JSON.parse(r.params!) as Record<string, string>).waId));
    expect([...waHashes]).toEqual([await subjectHash(env, ws, '201001234567')]); // the erasure hash of that person, whatever the spelling
  });
  it('a different record gives a different hash; the same record viewed twice gives the same one', async () => {
    const ws = W(4);
    await apiFor(ws);
    await asView(ws, '/contacts/201001234567/orders');
    await asView(ws, '/contacts/201001234567/orders');
    await asView(ws, '/contacts/201007654321/orders');
    const h = (await log(ws)).map((r) => (JSON.parse(r.params!) as Record<string, string>).waId);
    expect(h[0]).toBe(h[1]);
    expect(h[2]).not.toBe(h[0]);
  });
  it('fails closed (503) when the hash key is missing and the route carries a record id', async () => {
    const ws = W(5);
    await apiFor(ws);
    const { vi } = await import('vitest');
    const saved = env.ERASURE_HMAC_KEY;
    (env as { ERASURE_HMAC_KEY?: string }).ERASURE_HMAC_KEY = undefined;
    try {
      const res = await asView(ws, '/contacts/201001234567/orders');
      expect(res.status).toBe(503);
    } finally { (env as { ERASURE_HMAC_KEY?: string }).ERASURE_HMAC_KEY = saved; vi.restoreAllMocks(); }
  });
});
