import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStoreLink } from '../src/core/store-link';
import { ensureWorkspace } from '../src/core/workspace-registry';
import { apiKey, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { deliver, storeEvent, useStoreLink } from './helpers/store-link';
import { rows } from './helpers/workspace';

// Ruling CHAT-ENABLE-1: a workspace exists only because a store OWNER connected Ebda Chat (the Store's own action emits `store.linked`); the Store confirms the owner; nothing else creates one.
useApiKey();
const link = useStoreLink();
const OWNER = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f';
const STAFF = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const S = (n: number) => `00000000-0000-4000-8000-0000000094${String(n).padStart(2, '0')}`;
const registry = async (id: string) => (await env.DB.prepare('SELECT id, name FROM workspaces WHERE id = ?').bind(id).first<{ id: string; name: string }>()) ?? null;
const ownerRow = async (id: string) => (await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(id).first<{ owner_user_id: string }>()) ?? null;
const linked = (store: string, owner = OWNER) => storeEvent(store, 'store.linked', { ownerUserId: owner });
const conversations = async (store: string, userId = OWNER) => {
  const token = await mint(apiKey(), { sub: userId, stores: [{ id: store, role: 'owner' }] });
  return SELF.fetch(`https://x/api/v1/stores/${store}/conversations?filter=all&limit=50`, { headers: { authorization: `Bearer ${token}` } });
};
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });

describe('the owner connecting Chat in Store admin (store.linked) registers the store', () => {
  it('REPRODUCTION OF THE LIVE BUG: before the link every data route is 404; after the Store-confirmed owner links, the same call is 200', async () => {
    const store = S(1);
    link.fake.setMembers(store, [{ userId: OWNER, role: 'owner' }]);
    expect((await conversations(store)).status).toBe(404); // no registry row: workspaceStub() answers not_found (the prod symptom)
    const res = await deliver([linked(store)]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await registry(store)).toMatchObject({ id: store });
    expect(await ownerRow(store)).toEqual({ owner_user_id: OWNER });
    expect((await conversations(store)).status).toBe(200);
  });
  it('the registry name is the Store profile name; a missing profile falls back to the store id and still registers', async () => {
    const a = S(2);
    const b = S(3);
    link.fake.setMembers(a, [{ userId: OWNER, role: 'owner' }]);
    link.fake.setMembers(b, [{ userId: OWNER, role: 'owner' }]);
    await deliver([linked(a)]);
    expect((await registry(a))!.name.length).toBeGreaterThan(0);
    link.fake.failNext.set('getStoreProfile', 'unavailable');
    await deliver([linked(b)]);
    expect((await registry(b))!.name).toBe(b);
  });
  it('is idempotent: a second link (or a redelivery) changes nothing and keeps the first name', async () => {
    const store = S(4);
    link.fake.setMembers(store, [{ userId: OWNER, role: 'owner' }]);
    await deliver([linked(store)]);
    const first = await registry(store);
    await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind('Renamed', store).run();
    await deliver([linked(store)]);
    expect(await registry(store)).toEqual({ id: store, name: 'Renamed' });
    expect(first).not.toBeNull();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM workspaces WHERE id = ?').bind(store).first<{ n: number }>())!.n).toBe(1);
    expect(await ensureWorkspace(env, { storeId: store, ownerUserId: OWNER, name: 'x' })).toBe('exists');
  });
});

describe('only the Store-confirmed OWNER of exactly that store can register it', () => {
  it('a staff member, an unknown user and a user who owns ANOTHER store are refused: acknowledged, logged, no row', async () => {
    const mine = S(10);
    const other = S(11);
    link.fake.setMembers(mine, [{ userId: STAFF, role: 'staff' }, { userId: OWNER, role: 'owner' }]);
    link.fake.setMembers(other, [{ userId: OWNER, role: 'owner' }]);
    const staff = await deliver([linked(mine, STAFF)]);
    expect(staff.explicitAcks).toEqual(['e0']);
    expect(await registry(mine)).toBeNull();
    const stranger = await deliver([linked(mine, 'not-a-member')]);
    expect(stranger.explicitAcks).toEqual(['e0']);
    expect(await registry(mine)).toBeNull();
    const third = S(12); // OWNER owns `other`, not `third`: the Store has no such membership
    const cross = await deliver([linked(third, OWNER)]);
    expect(cross.explicitAcks).toEqual(['e0']);
    expect(await registry(third)).toBeNull();
  });
  it('a platform super admin token alone cannot create a workspace for a store: only the event path creates one (no route does), and the store routes stay 404', async () => {
    const store = S(13);
    const token = await mint(apiKey(), { sub: 'op-1', pa: 'super_admin', stores: [{ id: S(99), role: 'owner' }] } as never);
    for (const method of ['POST', 'PUT']) {
      const r = await SELF.fetch(`https://x/api/v1/stores/${store}/workspace`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      expect([401, 403, 404]).toContain(r.status); // there is no route that creates a workspace: a super admin gets nothing from this URL
    }
    expect(await registry(store)).toBeNull();
  });
  it('the Store cannot be reached: the link event is RETRIED (fail closed), nothing is registered on a guess', async () => {
    const store = S(14);
    link.fake.setMembers(store, [{ userId: OWNER, role: 'owner' }]);
    link.fake.failNext.set('memberRole', 'unavailable');
    const res = await deliver([linked(store)]);
    expect(res.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
    expect(await registry(store)).toBeNull();
  });
  it('no Store link configured (no bridge): nothing can confirm the owner, so nothing is registered', async () => {
    const store = S(15);
    const prev = configureStoreLink({ bridge: () => null });
    try {
      const res = await deliver([linked(store)]);
      expect(res.explicitAcks).toEqual(['e0']);
      expect(await registry(store)).toBeNull();
    } finally {
      configureStoreLink(prev);
    }
  });
});

describe('events for a store that never enabled Chat do not churn the queue', () => {
  it('a plan change racing just behind the link is retried a few times, then acknowledged and logged (never dead-lettered)', async () => {
    const store = S(20);
    const ev = storeEvent(store, 'store.plan_changed', { planCode: 'business', includesWhatsApp: true, ownerUserId: OWNER, effectiveAt: new Date().toISOString(), status: 'active' });
    for (const attempts of [1, 2, 3]) expect((await deliver([ev], attempts)).retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
    const last = await deliver([ev], 4);
    expect(last.explicitAcks).toEqual(['e0']);
    expect(last.retryMessages ?? []).toEqual([]);
    expect(await registry(store)).toBeNull(); // a plan change never creates a workspace
  });
  it('standing events (suspend / delete) for an unregistered store are acknowledged at once', async () => {
    const store = S(21);
    const res = await deliver([storeEvent(store, 'store.deleted', {})]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await registry(store)).toBeNull();
  });
});

describe('the registry row is what number connect, billing and routes hang off (FK)', () => {
  it('a phone number for an unregistered workspace is refused by the foreign key; after the owner links, the same insert works', async () => {
    const store = S(30);
    const insert = () => env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, display_phone, status) VALUES (?, ?, ?, ?, 'active')").bind(`pn-${store}`, 'waba-1', store, '+201000000000').run();
    await expect(insert()).rejects.toThrow(/FOREIGN KEY/i);
    link.fake.setMembers(store, [{ userId: OWNER, role: 'owner' }]);
    await deliver([linked(store)]);
    await insert();
    expect(await rows(store, 'SELECT 1')).toBeTruthy();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM phone_numbers WHERE workspace_id = ?').bind(store).first<{ n: number }>())!.n).toBe(1);
  });
});
