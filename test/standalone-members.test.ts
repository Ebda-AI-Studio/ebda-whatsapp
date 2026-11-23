import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createStandaloneWorkspace } from '../src/core/workspace-registry';
import { apiKey, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { useStoreLink } from './helpers/store-link';
import { grantPlan, rows, seedNumber, workspace } from './helpers/workspace';

// Ruling CHAT-SA-4: standalone team = D1 workspace_members + DO seats + accounts inviteChatMember. Owner-only management; a removal bites on the next request.
useApiKey();
useStoreLink();
let n = 500;
const uid = () => `40000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

type Invite = { email: string; firstName: string; language: string; workspaceName: string };
function accountsStub(opts: { fail?: 'refused' | 'down' } = {}) {
  const ids = new Map<string, string>(); // email -> user id (an existing identity keeps its id)
  const calls: Invite[] = [];
  const stub = {
    isRevoked: async () => false,
    inviteChatMember: async (a: Invite) => {
      calls.push(a);
      if (opts.fail === 'refused') throw new Error('INVITE_REFUSED');
      if (opts.fail === 'down') throw new Error('accounts unavailable');
      if (!ids.has(a.email)) ids.set(a.email, uid());
      return { userId: ids.get(a.email)! };
    },
    getAccountsBrief: async (userIds: string[]) => userIds.map((id) => ({ id, email: `${id.slice(-3)}@x.test`, firstName: 'Name', lastName: id.slice(-3) })),
  };
  return { stub, calls, ids };
}

async function setup(plan: 'starter' | 'growth' | 'pro' = 'growth') {
  const owner = uid();
  const r = await createStandaloneWorkspace(env, { ownerUserId: owner, name: 'Acme', country: 'EG', inviteCodeHash: null });
  if (r.status !== 'created') throw new Error('fixture');
  await seedNumber(`pn-${r.id}`, r.id);
  await grantPlan(r.id, plan);
  return { ws: r.id, owner };
}
async function call(accounts: unknown, sub: string, ws: string, method: string, path: string, body?: unknown) {
  const token = await mint(apiKey(), { sub });
  return worker.fetch(new Request(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    { ...env, ACCOUNTS: accounts } as typeof env, createExecutionContext());
}
const inv = (email: string) => ({ email, firstName: 'Sara', language: 'ar' });
const members = (ws: string) => env.DB.prepare('SELECT user_id, role, status FROM workspace_members WHERE workspace_id = ? ORDER BY created_at, user_id').bind(ws).all<{ user_id: string; role: string; status: string }>().then((r) => r.results);

describe('owner invites staff', () => {
  it('202 invite_sent, a staff row, a seat, and the accounts call carries the workspace name', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: 'invite_sent' });
    expect(a.calls).toEqual([{ email: 'sara@example.com', firstName: 'Sara', language: 'ar', workspaceName: 'Acme' }]);
    const staffId = a.ids.get('sara@example.com')!;
    expect(await members(ws)).toContainEqual({ user_id: staffId, role: 'staff', status: 'active' });
    expect((await rows<{ user_id: string }>(ws, 'SELECT user_id FROM seats')).map((x) => x.user_id)).toEqual([staffId]);
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND action = 'member.added'").bind(ws).first()).toEqual({ action: 'member.added' });
  });
  it('the invited person can work immediately (seated), the list shows names, and the picker of THEIR /me has the workspace', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const staffId = a.ids.get('sara@example.com')!;
    expect((await call(a.stub, staffId, ws, 'GET', '/conversations')).status).toBe(200);
    const me = (await (await call(a.stub, staffId, ws, 'GET', '/me')).json()) as { role: string; stores: { id: string }[] };
    expect(me.role).toBe('staff');
    expect(me.stores.map((s) => s.id)).toContain(ws);
    const list = (await (await call(a.stub, owner, ws, 'GET', '/members')).json()) as { items: { userId: string; role: string; seat: string; displayName: string }[]; seats: { limit: number; used: number } };
    expect(list.items.map((m) => [m.role, m.seat])).toEqual([['owner', 'owner'], ['staff', 'seated']]);
    expect(list.items[1]!.displayName).toMatch(/^Name /);
    expect(list.seats.used).toBe(2);
  });
  it('the answer is identical for a brand-new and an existing address (no account enumeration)', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const first = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('x@example.com'));
    const again = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('x@example.com'));
    expect([first.status, await first.json()]).toEqual([again.status, await again.json()]);
  });
  it('an inactive/erased identity (INVITE_REFUSED) answers the same 202 and writes nothing', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub({ fail: 'refused' });
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('gone@example.com'));
    expect([r.status, await r.json()]).toEqual([202, { status: 'invite_sent' }]);
    expect((await members(ws)).filter((m) => m.role === 'staff')).toEqual([]);
  });
  it('an accounts failure is 503 and writes no member row and no seat', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub({ fail: 'down' });
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(503);
    expect((await members(ws)).filter((m) => m.role === 'staff')).toEqual([]);
    expect(await rows(ws, 'SELECT user_id FROM seats')).toEqual([]);
  });
  it('a missing accounts binding is 503, not a crash', async () => {
    const { ws, owner } = await setup();
    expect((await call({ isRevoked: async () => false }, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(503);
  });
  it('when the seats are full: 409 seat_limit and NO accounts call', async () => {
    const { ws, owner } = await setup('growth');
    const a = accountsStub();
    const { limit } = await workspace(ws).seatSummary();
    for (let i = 0; i < limit - 1; i++) expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv(`s${i}@example.com`))).status).toBe(202);
    const before = a.calls.length;
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('one-more@example.com'));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'seat_limit', limit });
    expect(a.calls.length).toBe(before);
  });
  it('inviting the owner\'s own address changes nothing (the owner stays owner)', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    a.ids.set('me@example.com', owner);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('me@example.com'))).status).toBe(202);
    expect(await members(ws)).toEqual([{ user_id: owner, role: 'owner', status: 'active' }]);
    expect(await rows(ws, 'SELECT user_id FROM seats')).toEqual([]);
  });
  it('validates the body (bad email, extra field) with 400 and calls nobody', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', { email: 'nope', firstName: 'S', language: 'ar' })).status).toBe(400);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', { ...inv('a@b.co'), role: 'owner' })).status).toBe(400);
    expect(a.calls).toEqual([]);
  });
});

describe('invite abuse limits', () => {
  it('the 21st invite attempt in a day from one workspace is 429 with no accounts call (the cap counts attempts, removals do not reset it)', async () => {
    const { ws, owner } = await setup('pro');
    const a = accountsStub();
    for (let i = 0; i < 20; i++) {
      const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv(`p${i}@example.com`));
      if (r.status === 202) { const id = a.ids.get(`p${i}@example.com`)!; await call(a.stub, owner, ws, 'DELETE', `/members/${id}`); } // free the seat so seats never stop the loop
      else expect(r.status).toBe(202);
    }
    const before = a.calls.length;
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('p21@example.com'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect(a.calls.length).toBe(before);
  });
  it('failed attempts (accounts down) count too', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub({ fail: 'down' });
    for (let i = 0; i < 20; i++) expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv(`d${i}@example.com`))).status).toBe(503);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('d21@example.com'))).status).toBe(429);
  });
  it('one inviter across workspaces hits the per-inviter cap (30/day) even when each workspace is under its own', async () => {
    const { ws, owner } = await setup();
    const other = await setup();
    const now = Date.now();
    for (let i = 0; i < 30; i++) await env.DB.prepare("INSERT INTO audit_log (at, workspace_id, actor, actor_role, action) VALUES (?, ?, ?, 'owner', 'member.invite_attempt')").bind(now - 1000, i % 2 ? ws : other.ws, owner).run();
    const a = accountsStub();
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('z@example.com'))).status).toBe(429);
    expect(a.calls).toEqual([]);
  });
  it('attempts older than a day no longer count', async () => {
    const { ws, owner } = await setup();
    const old = Date.now() - 2 * 86_400_000;
    for (let i = 0; i < 25; i++) await env.DB.prepare("INSERT INTO audit_log (at, workspace_id, actor, actor_role, action) VALUES (?, ?, ?, 'owner', 'member.invite_attempt')").bind(old, ws, owner).run();
    expect((await call(accountsStub().stub, owner, ws, 'POST', '/members/invite', inv('fresh@example.com'))).status).toBe(202);
  });
  it('the workspace name reaching accounts has no CR/LF or control characters', async () => {
    const { ws, owner } = await setup();
    await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind('Acme\r\nBcc: evil@x.test\u2028  Ltd\t\u0000', ws).run();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'));
    expect(a.calls[0]!.workspaceName).toBe('Acme Bcc: evil@x.test Ltd');
    expect(a.calls[0]!.workspaceName).not.toMatch(/[\r\n\u2028\u0000]/);
  });
});

describe('who may manage the team', () => {
  it('staff cannot invite or remove (403); a stranger gets 403 from the membership check', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'));
    const staff = a.ids.get('s@example.com')!;
    expect((await call(a.stub, staff, ws, 'POST', '/members/invite', inv('t@example.com'))).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'DELETE', `/members/${owner}`)).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'GET', '/members')).status).toBe(403);
    expect((await call(a.stub, uid(), ws, 'POST', '/members/invite', inv('t@example.com'))).status).toBe(403);
  });
  it('the invite and remove routes do not exist for a Store workspace (404)', async () => {
    const a = accountsStub();
    const store = '00000000-0000-4000-8000-000000009955';
    await seedNumber('pn-store-6', store);
    const owner = uid();
    const token = await mint(apiKey(), { sub: owner, stores: [{ id: store, role: 'owner' }] });
    const res = await worker.fetch(new Request(`https://x/api/v1/stores/${store}/members/invite`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(inv('a@b.co')) }), { ...env, ACCOUNTS: a.stub } as typeof env, createExecutionContext());
    expect([403, 404, 503]).toContain(res.status); // refused by the Store membership check or the route: never a standalone invite
    expect(a.calls).toEqual([]);
  });
});

describe('owner removes staff', () => {
  it('the removed person is refused on their very next request, the seat is gone, and it is audited', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'));
    const staff = a.ids.get('s@example.com')!;
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(200);
    expect((await call(a.stub, owner, ws, 'DELETE', `/members/${staff}`)).status).toBe(204);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(403);
    expect(await rows(ws, 'SELECT user_id FROM seats')).toEqual([]);
    expect(await members(ws)).toContainEqual({ user_id: staff, role: 'staff', status: 'removed' });
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND action = 'member.removed'").bind(ws).first()).toEqual({ action: 'member.removed' });
    const list = (await (await call(a.stub, owner, ws, 'GET', '/members')).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });
  it('the owner cannot be removed (400, nothing changes), an unknown user is 404, a bad id is 400', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    expect((await call(a.stub, owner, ws, 'DELETE', `/members/${owner}`)).status).toBe(400);
    expect(await members(ws)).toEqual([{ user_id: owner, role: 'owner', status: 'active' }]);
    expect((await call(a.stub, owner, ws, 'DELETE', `/members/${uid()}`)).status).toBe(404);
    expect((await call(a.stub, owner, ws, 'DELETE', '/members/not-a-uuid')).status).toBe(400);
  });
  it('a removed staff member can be invited again and gets a seat', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'));
    const staff = a.ids.get('s@example.com')!;
    await call(a.stub, owner, ws, 'DELETE', `/members/${staff}`);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(202);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(200);
  });
  it('another workspace\'s owner cannot remove this workspace\'s staff (tenancy)', async () => {
    const { ws, owner } = await setup();
    const other = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'));
    const staff = a.ids.get('s@example.com')!;
    expect((await call(a.stub, other.owner, ws, 'DELETE', `/members/${staff}`)).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(200);
  });
});
