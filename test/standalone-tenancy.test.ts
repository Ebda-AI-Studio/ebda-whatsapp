import { SELF, createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { apiRoutes } from '../src/index';
import { createStandaloneWorkspace } from '../src/core/workspace-registry';
import { apiKey, storeId as W, useApiKey } from './helpers/api';
import { mint, mintClient } from './helpers/issuer';
import { seedNumber } from './helpers/workspace';
import { useStoreLink } from './helpers/store-link';

// Ruling CHAT-SA-2 / CHAT-SA-8: the id SHAPE picks the auth path. A Store id can never address an sw_ workspace and the reverse; membership of a standalone workspace is the live D1 row.
useApiKey();
const link = useStoreLink();
const A = '20000000-0000-4000-8000-00000000000a';
const B = '20000000-0000-4000-8000-00000000000b';
const C = '20000000-0000-4000-8000-00000000000c';
const OP = '20000000-0000-4000-8000-0000000000ff';
const STORE = W(3200);
let n = 100;
const uid = () => `30000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

async function standalone(owner: string): Promise<string> {
  const r = await createStandaloneWorkspace(env, { ownerUserId: owner, name: 'Acme', country: 'EG', inviteCodeHash: null });
  if (r.status !== 'created') throw new Error('fixture');
  await seedNumber(`pn-${r.id}`, r.id);
  return r.id;
}
const get = async (sub: string, ws: string, path = '/conversations', claims: Record<string, unknown> = {}, init: RequestInit = {}) =>
  SELF.fetch(`https://x/api/v1/stores/${ws}${path}`, { ...init, headers: { authorization: `Bearer ${await mint(apiKey(), { sub, ...claims })}`, ...(init.headers ?? {}) } });
const post = async (sub: string, ws: string, path: string, body: unknown, claims: Record<string, unknown> = {}) =>
  get(sub, ws, path, claims, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const setStaff = (ws: string, user: string, status: 'active' | 'removed' = 'active') =>
  env.DB.prepare("INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, ?, 'staff', ?, 'x', 1, 1)").bind(ws, user, status).run();
const seat = (ws: string, user: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws)).assignSeat(user, 'owner', [user]);

describe('standalone membership (D1, live)', () => {
  it('the owner reads and writes their own workspace', async () => {
    const o = uid(), ws = await standalone(o);
    expect((await get(o, ws)).status).toBe(200);
    expect((await get(o, ws, '/me')).status).toBe(200);
  });
  it('/me says kind standalone, store capability off, and lists the workspace in the picker with its kind', async () => {
    const o = uid(), ws = await standalone(o);
    const me = (await (await get(o, ws, '/me')).json()) as { kind: string; capabilities: { store: boolean; codOutcome: boolean }; stores: { id: string; kind: string; role: string }[]; workspace: boolean };
    expect(me.kind).toBe('standalone');
    expect(me.capabilities).toMatchObject({ store: false, codOutcome: false });
    expect(me.workspace).toBe(true);
    expect(me.stores).toContainEqual(expect.objectContaining({ id: ws, kind: 'standalone', role: 'owner' }));
  });
  it('the same person on sw_B they do not belong to is 403 (no row)', async () => {
    const o1 = uid(), o2 = uid();
    const ws1 = await standalone(o1), ws2 = await standalone(o2);
    expect((await get(o1, ws2)).status).toBe(403);
    expect((await post(o1, ws2, '/contacts/import', {})).status).toBe(403);
    expect((await get(o2, ws1)).status).toBe(403);
  });
  it('a forged token stores claim naming sw_B as owner grants nothing without a D1 row', async () => {
    const o1 = uid(), o2 = uid();
    await standalone(o1);
    const ws2 = await standalone(o2);
    const res = await get(o1, ws2, '/conversations', { stores: [{ id: ws2, role: 'owner' }] });
    expect([401, 403]).toContain(res.status);
  });
  it('a removed member is refused on the very next request (never-stale)', async () => {
    const o = uid(), ws = await standalone(o);
    const s = uid();
    await setStaff(ws, s);
    await seat(ws, s);
    expect((await get(s, ws)).status).toBe(200);
    await setStaff(ws, s, 'removed');
    expect((await get(s, ws)).status).toBe(403);
    expect((await post(s, ws, '/contacts/import', {})).status).toBe(403);
  });
  it('staff without a seat is 403 no_seat; with a seat 200', async () => {
    const o = uid(), ws = await standalone(o);
    const s = uid();
    await setStaff(ws, s);
    const r = await get(s, ws);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: 'no_seat' });
    await seat(ws, s);
    expect((await get(s, ws)).status).toBe(200);
  });
  it('an integrator token is refused on an sw_ path (403 when integrator tokens are on)', async () => {
    const o = uid(), ws = await standalone(o);
    const token = await mintClient(apiKey(), { storeId: ws });
    const res = await worker.fetch(new Request(`https://x/api/v1/stores/${ws}/conversations`, { headers: { authorization: `Bearer ${token}` } }),
      { ...env, INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } } as typeof env, createExecutionContext());
    expect([401, 403]).toContain(res.status);
  });
  it('malformed ids are 404 before any lookup', async () => {
    const o = uid();
    for (const bad of ['sw_SHORT', 'sw_aaaaaaaaaaaaaaaaaaaaaaaaaaa', 'SW_aaaaaaaaaaaaaaaaaaaaaaaaaa', '%73w_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'not-an-id', '..%2Fsw_aaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      expect((await get(o, bad)).status, bad).toBe(404);
    }
  });
  it('a well-formed sw_ id with no workspace is 404', async () => {
    expect((await get(uid(), 'sw_aaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
  });
  it('super admin non-member: read needs view-as, write needs the operator route', async () => {
    const ws = await standalone(uid());
    const r = await get(OP, ws, '/conversations', { pa: 'super_admin' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: 'view_as_required' });
    const w = await post(OP, ws, '/contacts/import', {}, { pa: 'super_admin' });
    expect(w.status).toBe(403);
    expect(await w.json()).toMatchObject({ message: 'operator_route_required' });
  });
  it('suspended: writes 403 workspace_suspended, reads stay, wallet stays allowed', async () => {
    const o = uid(), ws = await standalone(o);
    await env.DB.prepare('UPDATE workspaces SET suspended_at = 1, suspended_reason = ? WHERE id = ?').bind('operator', ws).run();
    const w = await post(o, ws, '/contacts/import', {});
    expect(w.status).toBe(403);
    expect(await w.json()).toMatchObject({ message: 'workspace_suspended' });
    expect((await get(o, ws)).status).toBe(200);
    expect((await post(o, ws, '/wallet/topups', { amountMinor: 10000 })).status).not.toBe(403);
  });
  it('fails closed: a D1 error on the membership read is 503, never 200', async () => {
    const o = uid(), ws = await standalone(o);
    await env.DB.prepare('ALTER TABLE workspace_members RENAME TO wm_hidden').run();
    try {
      expect((await get(o, ws)).status).toBe(503);
    } finally {
      await env.DB.prepare('ALTER TABLE wm_hidden RENAME TO workspace_members').run();
    }
    expect((await get(o, ws)).status).toBe(200);
  });
});

describe('a Store id can never take the standalone path (and keeps its own, with no new membership read)', () => {
  it('a D1 member of sw_A cannot reach Store S1 with a token claiming only sw_A; S1 stays Store-governed', async () => {
    const o = uid(), ws = await standalone(o);
    await seedNumber('pn-s1', STORE);
    link.fake.setMembers(STORE, [{ userId: uid(), role: 'owner' }]); // o is NOT a Store member
    expect((await get(o, STORE, '/conversations', { stores: [{ id: STORE, role: 'owner' }] })).status).toBe(403); // the Store's live answer refuses
    expect((await get(o, ws)).status).toBe(200); // and their own workspace is unaffected
  });
  it('a Store member reading a Store workspace never consults workspace_members (the table can be absent)', async () => {
    const o = uid();
    await seedNumber('pn-s2', STORE);
    link.fake.setMembers(STORE, [{ userId: o, role: 'owner' }]);
    await env.DB.prepare('ALTER TABLE workspace_members RENAME TO wm_hidden').run();
    try {
      expect((await get(o, STORE, '/conversations', { stores: [{ id: STORE, role: 'owner' }] })).status).toBe(200);
    } finally {
      await env.DB.prepare('ALTER TABLE wm_hidden RENAME TO workspace_members').run();
    }
  });
  it('a standalone member (D1 only) is not a member of a Store id even if their sub matches nothing there', async () => {
    const o = uid();
    await standalone(o);
    await seedNumber('pn-s3', C);
    expect((await get(o, C)).status).toBe(403);
  });
});

describe('every store-scoped route refuses a non-member on an sw_ workspace', () => {
  it('walks the router table: no route answers 2xx or 5xx to a stranger', async () => {
    const owner = uid(), stranger = uid();
    const ws = await standalone(owner);
    const routes = (apiRoutes.routes as { method: string; path: string }[]).filter((r) => r.path.startsWith('/stores/:storeId/') && r.method !== 'ALL' && !r.path.endsWith('/*'));
    expect(routes.length).toBeGreaterThan(50);
    const token = await mint(apiKey(), { sub: stranger });
    const bad: string[] = [];
    for (const r of routes) {
      const path = '/api/v1' + r.path.replace(':storeId', ws).replace(/:[A-Za-z]+/g, 'x');
      const res = await SELF.fetch(`https://x${path}`, { method: r.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { body: '{}' }) });
      if (res.status !== 403 && res.status !== 404) bad.push(`${r.method} ${path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('call sites reach the Store only through bridgeForWorkspace (standalone = no Store)', () => {
  it('the orders route answers the labelled sample (no Store) and cod-outcome store_link_off for a standalone workspace', async () => {
    const o = uid(), ws = await standalone(o);
    const r = await get(o, ws, '/contacts/201001234567/orders');
    expect(await r.json()).toEqual({ items: [], source: 'sample' });
    const c = await post(o, ws, '/contacts/201001234567/orders/1001/cod-outcome', { outcome: 'confirmed' });
    expect(c.status).not.toBe(200);
  });
  it('members route answers store_link_off for a standalone workspace (team arrives with PR-6)', async () => {
    const o = uid(), ws = await standalone(o);
    const r = await get(o, ws, '/members');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ message: 'store_link_off' });
  });
});

describe('review fixes (#188)', () => {
  it('a Store merchant\'s /me stays 200 when the standalone picker read fails (table missing / pre-migration deploy)', async () => {
    const o = uid();
    await seedNumber('pn-me1', STORE);
    link.fake.setMembers(STORE, [{ userId: o, role: 'owner' }]);
    await env.DB.prepare('ALTER TABLE workspace_members RENAME TO wm_hidden').run();
    try {
      const r = await get(o, STORE, '/me', { stores: [{ id: STORE, role: 'owner' }] });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { kind: string; stores: { kind?: string }[] };
      expect(body.kind).toBe('store');
      expect(body.stores.every((x) => x.kind !== 'standalone')).toBe(true);
    } finally {
      await env.DB.prepare('ALTER TABLE wm_hidden RENAME TO workspace_members').run();
    }
  });

  async function socket(ws: string, sub: string) {
    const token = await mint(apiKey(), { sub });
    const res = await SELF.fetch(`https://x/api/v1/stores/${ws}/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `inbox.v1, bearer.${token}` } });
    expect(res.status).toBe(101);
    const sock = res.webSocket!;
    sock.accept();
    const state = { frames: 0, closeCode: 0 };
    sock.addEventListener('message', () => { state.frames++; });
    sock.addEventListener('close', (e) => { state.closeCode = e.code; });
    return state;
  }
  const stub = (ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
  const sweep = (ws: string) => runInDurableObject(stub(ws), (inst: unknown) => (inst as { sweepSockets(n: number): Promise<void> }).sweepSockets(Date.now() / 1000));

  it('a standalone staff socket closes (4403) when its seat is removed, with no Store bridge involved', async () => {
    const o = uid(), ws = await standalone(o);
    const s = uid();
    await setStaff(ws, s);
    await seat(ws, s);
    const sock = await socket(ws, s);
    await stub(ws).removeSeat(s);
    await vi.waitFor(() => expect(sock.closeCode).toBe(4403), { timeout: 3000, interval: 10 });
  });
  it('a standalone socket whose member row was removed closes on the next sweep, even if the seat row lingers', async () => {
    const o = uid(), ws = await standalone(o);
    const s = uid();
    await setStaff(ws, s);
    await seat(ws, s);
    const sock = await socket(ws, s);
    await setStaff(ws, s, 'removed');
    await sweep(ws);
    await vi.waitFor(() => expect(sock.closeCode).toBe(4403), { timeout: 3000, interval: 10 });
  });
  it('an active member\'s socket survives a sweep', async () => {
    const o = uid(), ws = await standalone(o);
    const sock = await socket(ws, o);
    await sweep(ws);
    await new Promise((r) => setTimeout(r, 150));
    expect(sock.closeCode).toBe(0);
  });
  it('a sweep with the membership read failing leaves the socket (next sweep retries)', async () => {
    const o = uid(), ws = await standalone(o);
    const sock = await socket(ws, o);
    await env.DB.prepare('ALTER TABLE workspace_members RENAME TO wm_hidden').run();
    try { await sweep(ws); } finally { await env.DB.prepare('ALTER TABLE wm_hidden RENAME TO workspace_members').run(); }
    await new Promise((r) => setTimeout(r, 150));
    expect(sock.closeCode).toBe(0);
  });
});
void A; void B;
