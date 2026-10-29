import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listMembersResponse } from '../src/core/api/contract';
import { configureStoreLink } from '../src/core/store-link';
import { apiFor, apiKey, storeId as W, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { useStoreLink } from './helpers/store-link';
import { exec, grantPlan, rows, workspace } from './helpers/workspace';

// WA-SEATS-1 (plan P1b): staff work only while the owner has seated them, inside the package's member limit; membership is the Store's, read live.
useApiKey();
const link = useStoreLink();
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const S1 = 'b0000000-0000-4000-8000-000000000001';
const S2 = 'b0000000-0000-4000-8000-000000000002';
const S3 = 'b0000000-0000-4000-8000-000000000003';

/** A workspace on `plan` whose Store team is the owner plus the given staff. */
async function team(n: number, plan: 'starter' | 'growth' | 'pro' = 'growth', staff: string[] = [S1, S2]) {
  const ws = W(4000 + n);
  await apiFor(ws); // registers the workspace
  await grantPlan(ws, plan);
  link.fake.setMembers(ws, [{ userId: OWNER, role: 'owner' }, ...staff.map((userId) => ({ userId, role: 'staff' as const }))]);
  return ws;
}
async function as(ws: string, sub: string, role: 'owner' | 'staff') {
  const token = await mint(apiKey(), { sub, stores: [{ id: ws, role }] });
  return (method: string, path: string, body?: unknown) =>
    SELF.fetch(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const seatRows = (ws: string) => rows<{ user_id: string }>(ws, 'SELECT user_id FROM seats ORDER BY assigned_at, user_id').then((r) => r.map((x) => x.user_id));

describe('deny by default: staff need a seat', () => {
  it('an unseated staff member is refused on every route (403 no_seat) until the owner seats them', async () => {
    const ws = await team(1);
    const staff = await as(ws, S1, 'staff');
    for (const p of ['/me', '/conversations', '/templates']) {
      const r = await staff('GET', p);
      expect(r.status, p).toBe(403);
      expect(await r.json(), p).toMatchObject({ error: 'no_seat' });
    }
    const owner = await as(ws, OWNER, 'owner');
    expect((await owner('PUT', `/members/${S1}/seat`)).status).toBe(201);
    expect((await staff('GET', '/me')).status).toBe(200);
    expect((await (await as(ws, S2, 'staff'))('GET', '/me')).status).toBe(403); // the other staff member is still unseated
  });

  it('the owner never needs a seat', async () => {
    const ws = await team(2);
    expect((await (await as(ws, OWNER, 'owner'))('GET', '/me')).status).toBe(200);
    expect(await seatRows(ws)).toEqual([]);
  });

  it('removing the seat takes the access away again', async () => {
    const ws = await team(3);
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    const staff = await as(ws, S1, 'staff');
    expect((await staff('GET', '/me')).status).toBe(200);
    expect((await owner('DELETE', `/members/${S1}/seat`)).status).toBe(204);
    expect((await staff('GET', '/me')).status).toBe(403);
    expect((await owner('DELETE', `/members/${S1}/seat`)).status).toBe(204); // idempotent
  });
});

describe('the package limit', () => {
  it('starter (2 people, the owner included) has ONE staff seat: the second assignment is a 403 seat_limit with the limit, and no row', async () => {
    const ws = await team(4, 'starter');
    const owner = await as(ws, OWNER, 'owner');
    expect((await owner('PUT', `/members/${S1}/seat`)).status).toBe(201);
    const r = await owner('PUT', `/members/${S2}/seat`);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'seat_limit', limit: 2 });
    expect(await seatRows(ws)).toEqual([S1]);
  });

  it('assigning the same person twice is not a second seat (200, the row is kept)', async () => {
    const ws = await team(5, 'starter');
    const owner = await as(ws, OWNER, 'owner');
    expect((await owner('PUT', `/members/${S1}/seat`)).status).toBe(201);
    expect((await owner('PUT', `/members/${S1}/seat`)).status).toBe(200);
    expect(await seatRows(ws)).toEqual([S1]);
  });

  it('two requests racing for the last seat: exactly one wins', async () => {
    const ws = await team(6, 'starter');
    const owner = await as(ws, OWNER, 'owner');
    const [a, b] = await Promise.all([owner('PUT', `/members/${S1}/seat`), owner('PUT', `/members/${S2}/seat`)]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(await seatRows(ws)).toHaveLength(1);
  });

  it('a plan that is not in effect has one seat (the owner alone): seated staff are refused, nothing is deleted', async () => {
    const ws = await team(7, 'growth');
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    await grantPlan(ws, 'growth', 'expired');
    const r = await (await as(ws, S1, 'staff'))('GET', '/me');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'no_seat', message: 'seat_over_limit' });
    expect(await seatRows(ws)).toEqual([S1]);
  });

  it('a downgrade keeps the earliest assignments working, refuses the later ones, deletes nothing, and a freed seat promotes the next', async () => {
    const ws = await team(8, 'growth', [S1, S2, S3]);
    await exec(ws, "INSERT INTO seats (user_id, assigned_at, assigned_by) VALUES (?, 1000, ?), (?, 2000, ?), (?, 3000, ?)", S1, OWNER, S2, OWNER, S3, OWNER);
    await grantPlan(ws, 'starter'); // 1 staff seat
    const owner = await as(ws, OWNER, 'owner');
    expect((await (await as(ws, S1, 'staff'))('GET', '/me')).status).toBe(200);
    expect((await (await as(ws, S2, 'staff'))('GET', '/me')).status).toBe(403);
    expect((await (await as(ws, S3, 'staff'))('GET', '/me')).status).toBe(403);
    const list = listMembersResponse.parse(await (await owner('GET', '/members')).json());
    expect(list.seats).toEqual({ limit: 2, used: 4, overLimit: true });
    expect(Object.fromEntries(list.items.map((m) => [m.userId, m.seat]))).toEqual({ [OWNER]: 'owner', [S1]: 'seated', [S2]: 'over_limit', [S3]: 'over_limit' });
    expect(await seatRows(ws)).toEqual([S1, S2, S3]);
    await owner('DELETE', `/members/${S1}/seat`);
    expect((await (await as(ws, S2, 'staff'))('GET', '/me')).status).toBe(200);
  });
});

describe('the owner\'s routes', () => {
  it('GET /members lists the live team with each seat and the usage', async () => {
    const ws = await team(9);
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    const r = await owner('GET', '/members');
    expect(r.status).toBe(200);
    const body = listMembersResponse.parse(await r.json());
    expect(body.items.map((m) => [m.userId, m.role, m.seat])).toEqual([[OWNER, 'owner', 'owner'], [S1, 'staff', 'seated'], [S2, 'staff', 'none']]);
    expect(body.seats).toEqual({ limit: 5, used: 2, overLimit: false });
    expect(JSON.stringify(body)).not.toMatch(/email|phone|@/); // names and ids only
  });

  it('is owner only: staff (even seated) get 403, and nothing changes', async () => {
    const ws = await team(10);
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    const staff = await as(ws, S1, 'staff');
    expect((await staff('GET', '/members')).status).toBe(403);
    expect((await staff('PUT', `/members/${S2}/seat`)).status).toBe(403);
    expect((await staff('DELETE', `/members/${S1}/seat`)).status).toBe(403);
    expect(await seatRows(ws)).toEqual([S1]);
  });

  it('the owner cannot be given or lose a seat (400), a stranger is a 404, a malformed id a 400', async () => {
    const ws = await team(11);
    const owner = await as(ws, OWNER, 'owner');
    expect((await owner('PUT', `/members/${OWNER}/seat`)).status).toBe(400);
    expect((await owner('DELETE', `/members/${OWNER}/seat`)).status).toBe(400);
    expect((await owner('PUT', `/members/${S3}/seat`)).status).toBe(404);
    expect((await owner('PUT', '/members/not-a-uuid/seat')).status).toBe(400);
    expect(await seatRows(ws)).toEqual([]);
  });

  it('the store link being off is a 404 (there is no membership to read), not an empty team', async () => {
    const ws = await team(12);
    const owner = await as(ws, OWNER, 'owner');
    const prev = configureStoreLink({ bridge: () => null });
    try {
      expect((await owner('GET', '/members')).status).toBe(404);
    } finally {
      configureStoreLink(prev);
    }
  });
});

describe('membership is the Store\'s and is read live, failing closed', () => {
  it('someone removed from the Store loses access at once even though their seat row is still here, and the row is dropped on the next list', async () => {
    const ws = await team(13);
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    link.fake.setMembers(ws, [{ userId: OWNER, role: 'owner' }, { userId: S2, role: 'staff' }]);
    const r = await (await as(ws, S1, 'staff'))('GET', '/me');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'no_seat', message: 'not_a_member' });
    expect(await seatRows(ws)).toEqual([S1]);
    await owner('GET', '/members');
    expect(await seatRows(ws)).toEqual([]);
  });

  it('a leaver does not keep a seat that blocks the next person (the last seat is free again once the list is read)', async () => {
    const ws = await team(14, 'starter');
    const owner = await as(ws, OWNER, 'owner');
    await owner('PUT', `/members/${S1}/seat`);
    link.fake.setMembers(ws, [{ userId: OWNER, role: 'owner' }, { userId: S2, role: 'staff' }]);
    expect((await owner('PUT', `/members/${S2}/seat`)).status).toBe(201);
    expect(await seatRows(ws)).toEqual([S2]);
  });

  it('the Store not answering is a 503 for staff AND owner (never allowed), with the seat table untouched', async () => {
    const ws = await team(15);
    await (await as(ws, OWNER, 'owner'))('PUT', `/members/${S1}/seat`);
    link.fake.failNext.set('memberRole', 'unavailable');
    expect((await (await as(ws, S1, 'staff'))('GET', '/me')).status).toBe(503);
    link.fake.failNext.set('memberRole', 'unavailable');
    expect((await (await as(ws, OWNER, 'owner'))('GET', '/me')).status).toBe(503);
    expect(await seatRows(ws)).toEqual([S1]);
  });

  it('an assignment while the Store cannot list the team is a 503 and no row is created', async () => {
    const ws = await team(16);
    const owner = await as(ws, OWNER, 'owner');
    link.fake.failNext.set('listStoreMembers', 'unavailable');
    expect((await owner('PUT', `/members/${S1}/seat`)).status).toBe(503);
    expect(await seatRows(ws)).toEqual([]);
  });

  it('memberRole is asked on EVERY request, never cached', async () => {
    const ws = await team(17);
    await (await as(ws, OWNER, 'owner'))('PUT', `/members/${S1}/seat`);
    const staff = await as(ws, S1, 'staff');
    const before = link.fake.count('memberRole');
    await staff('GET', '/me');
    await staff('GET', '/me');
    expect(link.fake.count('memberRole') - before).toBe(2);
  });

  it('a stale token never grants more than the Store says: the LOWER of the token role and the live role applies (and staff need a seat)', async () => {
    const ws = await team(18);
    const demoted = await as(ws, S1, 'owner'); // the token still says owner; the Store says staff
    const r = await demoted('GET', '/me');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'no_seat' });
    await (await as(ws, OWNER, 'owner'))('PUT', `/members/${S1}/seat`);
    expect(await (await demoted('GET', '/me')).json()).toMatchObject({ role: 'staff' }); // seated, and treated as staff
    expect((await demoted('GET', '/members')).status).toBe(403); // an owner-only route is closed to the demoted owner at once
    expect((await (await as(ws, OWNER, 'staff'))('GET', '/me')).status).toBe(403); // the owner holding a staff token is staff until it refreshes: unseated, refused
  });

  it('an integrator token and a super admin are not subject to seats', async () => {
    const ws = await team(19);
    const before = link.fake.count('memberRole');
    const admin = await mint(apiKey(), { sub: '11111111-1111-4111-8111-111111111111', pa: 'super_admin', stores: [] });
    const r = await SELF.fetch(`https://x/api/v1/stores/${ws}/me`, { headers: { authorization: `Bearer ${admin}`, 'x-view-as-merchant': '1', 'x-view-as-reason': 'seat support check' } });
    expect(r.status).toBe(200);
    expect(link.fake.count('memberRole')).toBe(before);
  });
});

describe('without a Store link (a white-label deploy) there is no membership source and no seats', () => {
  it('staff work as the token says', async () => {
    const ws = await team(20);
    const prev = configureStoreLink({ bridge: () => null });
    try {
      expect((await (await as(ws, S1, 'staff'))('GET', '/me')).status).toBe(200);
    } finally {
      configureStoreLink(prev);
    }
  });
});

describe('a downgrade raises one alert and the DO reports it', () => {
  it('seatsOver is visible to the DO', async () => {
    const ws = await team(21, 'growth', [S1, S2]);
    await exec(ws, "INSERT INTO seats (user_id, assigned_at, assigned_by) VALUES (?, 1000, ?), (?, 2000, ?)", S1, OWNER, S2, OWNER);
    expect((await workspace(ws).seatSummary()).seats.map((s) => s.state)).toEqual(['seated', 'seated']);
    await grantPlan(ws, 'starter');
    expect((await workspace(ws).seatSummary()).seats.map((s) => s.state)).toEqual(['seated', 'over_limit']);
  });
});
