import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { reserveInviteAttempt } from '../src/core/standalone-members';
import { createStandaloneWorkspace } from '../src/core/workspace-registry';
import { apiKey, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { useStoreLink } from './helpers/store-link';
import { exec, grantPlan, rows, seedNumber, workspace } from './helpers/workspace';
import { configureSessionCheck } from '../src/core/identity/session';

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
async function callPerson(accounts: unknown, sub: string, method: string, path: string) {
  const token = await mint(apiKey(), { sub });
  return worker.fetch(new Request(`https://x/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } }), { ...env, ACCOUNTS: accounts } as typeof env, createExecutionContext());
}
/** Invite then accept as the invited identity: what a real invitee does. */
async function onTeam(a: ReturnType<typeof accountsStub>, ws: string, owner: string, email: string) {
  expect((await call(a.stub, owner, ws, 'POST', '/members/invite', { email, firstName: 'Sara', language: 'ar' })).status).toBe(202);
  const id = a.ids.get(email)!;
  expect((await callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(200);
  return id;
}
const inv = (email: string) => ({ email, firstName: 'Sara', language: 'ar' });
const invitation = (ws: string, user: string) => env.DB.prepare('SELECT status, email, first_name, expires_at FROM workspace_invitations WHERE workspace_id = ? AND user_id = ?').bind(ws, user).first<{ status: string; email: string; first_name: string; expires_at: number }>();
const members = (ws: string) => env.DB.prepare('SELECT user_id, role, status FROM workspace_members WHERE workspace_id = ? ORDER BY created_at, user_id').bind(ws).all<{ user_id: string; role: string; status: string }>().then((r) => r.results);

describe('owner invites: a pending invitation, not a membership', () => {
  it('202 invite_sent; a pending invitation holding what the owner typed; NO membership, NO seat, NO access; accounts gets the workspace name', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: 'invite_sent' });
    expect(a.calls).toEqual([{ email: 'sara@example.com', firstName: 'Sara', language: 'ar', workspaceName: 'Acme' }]);
    const id = a.ids.get('sara@example.com')!;
    expect(await invitation(ws, id)).toMatchObject({ status: 'pending', email: 'sara@example.com', first_name: 'Sara' });
    expect((await members(ws)).filter((m) => m.role === 'staff')).toEqual([]);
    expect(await rows(ws, 'SELECT user_id FROM seats')).toEqual([]);
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(403); // an invited person cannot use the workspace before accepting
    expect((await call(a.stub, id, ws, 'GET', '/me')).status).toBe(403);
  });
  it('the owner sees the pending invitation with what THEY typed, and no accounts profile is read for it', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const brief = vi.spyOn(a.stub, 'getAccountsBrief');
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const list = (await (await call(a.stub, owner, ws, 'GET', '/members')).json()) as { items: { role: string }[]; invitations: { email: string; firstName: string }[] };
    expect(list.items.map((m) => m.role)).toEqual(['owner']);
    expect(list.invitations).toEqual([expect.objectContaining({ email: 'sara@example.com', firstName: 'Sara' })]);
    for (const c of brief.mock.calls) expect(c[0]).toEqual([owner]); // only the (accepted) owner is ever looked up
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
    expect((await env.DB.prepare('SELECT count(*) AS n FROM workspace_invitations WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
  it('an accounts failure is 503 and writes no invitation', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub({ fail: 'down' });
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(503);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM workspace_invitations WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
  it('a missing accounts binding is 503, not a crash', async () => {
    const { ws, owner } = await setup();
    expect((await call({ isRevoked: async () => false }, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(503);
  });
  it('seats full (active staff + open invitations): 409 seat_limit and NO accounts call', async () => {
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
  it('the owner\'s own address, and an address already on the team, change nothing', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    a.ids.set('me@example.com', owner);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('me@example.com'))).status).toBe(202);
    expect(await invitation(ws, owner)).toBeNull();
    const id = await onTeam(a, ws, owner, 's@example.com');
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(202);
    expect(await invitation(ws, id)).toMatchObject({ status: 'accepted' });
  });
  it('validates the body (bad email, extra field) with 400 and calls nobody', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', { email: 'nope', firstName: 'S', language: 'ar' })).status).toBe(400);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', { ...inv('a@b.co'), role: 'owner' })).status).toBe(400);
    expect(a.calls).toEqual([]);
  });
});

describe('accepting (consent, bound to the invited identity)', () => {
  it('the invitee accepts as themselves: active staff, seated, can work, shows in their picker, listed to the owner with the accounts name', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const id = await onTeam(a, ws, owner, 'sara@example.com');
    expect(await members(ws)).toContainEqual({ user_id: id, role: 'staff', status: 'active' });
    expect((await rows<{ user_id: string }>(ws, 'SELECT user_id FROM seats')).map((x) => x.user_id)).toEqual([id]);
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(200);
    const me = (await (await call(a.stub, id, ws, 'GET', '/me')).json()) as { role: string; stores: { id: string }[] };
    expect(me.role).toBe('staff');
    expect(me.stores.map((x) => x.id)).toContain(ws);
    const list = (await (await call(a.stub, owner, ws, 'GET', '/members')).json()) as { items: { role: string; seat: string; displayName: string }[]; invitations: unknown[] };
    expect(list.items.map((m) => [m.role, m.seat])).toEqual([['owner', 'owner'], ['staff', 'seated']]);
    expect(list.items[1]!.displayName).toMatch(/^Name /); // accounts names only after acceptance
    expect(list.invitations).toEqual([]);
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND action = 'member.added'").bind(ws).first()).toEqual({ action: 'member.added' });
  });
  it('the invitee sees the invitation in GET /workspaces/invitations (and nobody else does)', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    expect(await (await callPerson(a.stub, id, 'GET', '/workspaces/invitations')).json()).toEqual({ items: [{ workspaceId: ws, workspaceName: 'Acme', expiresAt: expect.any(String) }] });
    expect(await (await callPerson(a.stub, uid(), 'GET', '/workspaces/invitations')).json()).toEqual({ items: [] });
  });
  it('accepting as a DIFFERENT identity fails (404) and grants nothing, even for the owner or an invited person of another workspace', async () => {
    const { ws, owner } = await setup();
    const other = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    for (const who of [uid(), other.owner, owner]) expect((await callPerson(a.stub, who, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(404);
    expect((await members(ws)).filter((m) => m.role === 'staff')).toEqual([]);
    expect(await invitation(ws, id)).toMatchObject({ status: 'pending' }); // still waiting for the right person
  });
  it('an expired invitation cannot be accepted (and is not listed)', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    await env.DB.prepare('UPDATE workspace_invitations SET expires_at = ? WHERE workspace_id = ? AND user_id = ?').bind(Date.now() - 1000, ws, id).run();
    expect((await callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(404);
    expect(await (await callPerson(a.stub, id, 'GET', '/workspaces/invitations')).json()).toEqual({ items: [] });
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(403);
    const list = (await (await call(a.stub, owner, ws, 'GET', '/members')).json()) as { invitations: unknown[] };
    expect(list.invitations).toEqual([]);
  });
  it('the invitation lasts 7 days', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const t0 = Date.now();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const inv1 = await invitation(ws, a.ids.get('sara@example.com')!);
    expect(inv1!.expires_at - t0).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(inv1!.expires_at - t0).toBeLessThan(7 * 86_400_000 + 60_000);
  });
  it('the owner can revoke: the link stops working and nothing was ever granted', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    expect((await call(a.stub, owner, ws, 'DELETE', `/members/invitations/${id}`)).status).toBe(204);
    expect((await callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(404);
    expect((await call(a.stub, owner, ws, 'DELETE', `/members/invitations/${id}`)).status).toBe(404); // already withdrawn
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(403);
  });
  it('accepting twice is harmless (the second is 404) and keeps the seat', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const id = await onTeam(a, ws, owner, 'sara@example.com');
    expect((await callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(404);
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(200);
  });
  it('two concurrent accepts of one invitation leave the member seated', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    await Promise.all([callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`), callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)]);
    expect((await call(a.stub, id, ws, 'GET', '/conversations')).status).toBe(200);
    expect((await rows<{ user_id: string }>(ws, 'SELECT user_id FROM seats')).map((x) => x.user_id)).toEqual([id]);
  });
  it('accepting needs a person token: no token 401; a revoked session 403; malformed workspace id 404; a Store id 404', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('sara@example.com'));
    const id = a.ids.get('sara@example.com')!;
    const anon = await worker.fetch(new Request(`https://x/api/v1/workspaces/invitations/${ws}/accept`, { method: 'POST' }), { ...env, ACCOUNTS: a.stub } as typeof env, createExecutionContext());
    expect(anon.status).toBe(401);
    configureSessionCheck(async () => true);
    try { expect((await callPerson(a.stub, id, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(403); } finally { configureSessionCheck(null); }
    expect((await callPerson(a.stub, id, 'POST', '/workspaces/invitations/sw_short/accept')).status).toBe(404);
    expect((await callPerson(a.stub, id, 'POST', '/workspaces/invitations/00000000-0000-4000-8000-000000009955/accept')).status).toBe(404);
  });
  it('the seat is the authority: a full package at accept time is 409 and the invitation stays pending', async () => {
    const { ws, owner } = await setup('growth');
    const a = accountsStub();
    const { limit } = await workspace(ws).seatSummary();
    const pending: string[] = [];
    for (let i = 0; i < limit - 1; i++) { await call(a.stub, owner, ws, 'POST', '/members/invite', inv(`q${i}@example.com`)); pending.push(a.ids.get(`q${i}@example.com`)!); }
    // fill every seat behind the invitations' back (an owner grant elsewhere), then the last invitee tries to accept
    for (let i = 0; i < limit - 1; i++) {
      const filler = uid(); // real active staff holding the seats (a seat of a non-member is pruned by design)
      await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, ?, 'staff', 'active', 'x', 1, 1)").bind(ws, filler).run();
      await exec(ws, "INSERT INTO seats (user_id, assigned_at, assigned_by) VALUES (?, 0, 'fixture')", filler);
    }
    const r = await callPerson(a.stub, pending[0]!, 'POST', `/workspaces/invitations/${ws}/accept`);
    expect(r.status).toBe(409);
    expect(await invitation(ws, pending[0]!)).toMatchObject({ status: 'pending' });
    expect((await call(a.stub, pending[0]!, ws, 'GET', '/conversations')).status).toBe(403);
  });
});

describe('invite abuse limits (atomic, fail closed)', () => {
  it('N parallel invites at cap-1: exactly one is reserved', async () => {
    const { ws, owner } = await setup('pro');
    const now = Date.now();
    for (let i = 0; i < 19; i++) await env.DB.prepare('INSERT INTO invite_attempts (workspace_id, inviter, at) VALUES (?, ?, ?)').bind(ws, owner, now - 1000).run();
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveInviteAttempt(env, ws, owner, Date.now())));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM invite_attempts WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(20);
  });
  it('parallel invite REQUESTS at cap-1 call accounts exactly once', async () => {
    const { ws, owner } = await setup('pro');
    const now = Date.now();
    for (let i = 0; i < 19; i++) await env.DB.prepare('INSERT INTO invite_attempts (workspace_id, inviter, at) VALUES (?, ?, ?)').bind(ws, owner, now - 1000).run();
    const a = accountsStub();
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => call(a.stub, owner, ws, 'POST', '/members/invite', inv(`par${i}@example.com`))));
    expect(res.filter((r) => r.status === 202)).toHaveLength(1);
    expect(res.filter((r) => r.status === 429)).toHaveLength(5);
    expect(a.calls).toHaveLength(1);
  });
  it('the 21st attempt in a day from one workspace is 429 with retry-after and no accounts call', async () => {
    const { ws, owner } = await setup('pro');
    const now = Date.now();
    for (let i = 0; i < 20; i++) await env.DB.prepare('INSERT INTO invite_attempts (workspace_id, inviter, at) VALUES (?, ?, ?)').bind(ws, owner, now - 1000).run();
    const a = accountsStub();
    const r = await call(a.stub, owner, ws, 'POST', '/members/invite', inv('p21@example.com'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect(a.calls).toEqual([]);
  });
  it('failed attempts (accounts down) use the allowance', async () => {
    const { ws, owner } = await setup('pro');
    const a = accountsStub({ fail: 'down' });
    for (let i = 0; i < 20; i++) expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv(`d${i}@example.com`))).status).toBe(503);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('d21@example.com'))).status).toBe(429);
  });
  it('one inviter across workspaces hits the per-inviter cap (30/day) though each workspace is under its own', async () => {
    const { ws, owner } = await setup();
    const other = await setup();
    const now = Date.now();
    for (let i = 0; i < 30; i++) await env.DB.prepare('INSERT INTO invite_attempts (workspace_id, inviter, at) VALUES (?, ?, ?)').bind(i % 2 ? ws : other.ws, owner, now - 1000).run();
    const a = accountsStub();
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('z@example.com'))).status).toBe(429);
    expect(a.calls).toEqual([]);
  });
  it('attempts older than a day no longer count', async () => {
    const { ws, owner } = await setup();
    const old = Date.now() - 2 * 86_400_000;
    for (let i = 0; i < 25; i++) await env.DB.prepare('INSERT INTO invite_attempts (workspace_id, inviter, at) VALUES (?, ?, ?)').bind(ws, owner, old).run();
    expect((await call(accountsStub().stub, owner, ws, 'POST', '/members/invite', inv('fresh@example.com'))).status).toBe(202);
  });
  it('FAILS CLOSED: if the reservation write errors the invite is 503, accounts is never called', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    await env.DB.prepare('ALTER TABLE invite_attempts RENAME TO ia_hidden').run();
    try {
      expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(503);
    } finally {
      await env.DB.prepare('ALTER TABLE ia_hidden RENAME TO invite_attempts').run();
    }
    expect(a.calls).toEqual([]);
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
  it('staff cannot invite, revoke or remove (403); a stranger gets 403 from the membership check', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const staff = await onTeam(a, ws, owner, 's@example.com');
    expect((await call(a.stub, staff, ws, 'POST', '/members/invite', inv('t@example.com'))).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'DELETE', `/members/${owner}`)).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'DELETE', `/members/invitations/${uid()}`)).status).toBe(403);
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
    expect([403, 404, 503]).toContain(res.status);
    expect(a.calls).toEqual([]);
  });
});

describe('owner removes staff', () => {
  it('the removed person is refused on their very next request, the seat is gone, and it is audited', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const staff = await onTeam(a, ws, owner, 's@example.com');
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
  it('a removed staff member can be invited again and must accept again', async () => {
    const { ws, owner } = await setup();
    const a = accountsStub();
    const staff = await onTeam(a, ws, owner, 's@example.com');
    await call(a.stub, owner, ws, 'DELETE', `/members/${staff}`);
    expect((await call(a.stub, owner, ws, 'POST', '/members/invite', inv('s@example.com'))).status).toBe(202);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(403); // removed until they accept again
    expect((await callPerson(a.stub, staff, 'POST', `/workspaces/invitations/${ws}/accept`)).status).toBe(200);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(200);
  });
  it('another workspace\'s owner cannot remove or revoke in this workspace (tenancy)', async () => {
    const { ws, owner } = await setup();
    const other = await setup();
    const a = accountsStub();
    const staff = await onTeam(a, ws, owner, 's@example.com');
    await call(a.stub, owner, ws, 'POST', '/members/invite', inv('p@example.com'));
    const pend = a.ids.get('p@example.com')!;
    expect((await call(a.stub, other.owner, ws, 'DELETE', `/members/${staff}`)).status).toBe(403);
    expect((await call(a.stub, other.owner, ws, 'DELETE', `/members/invitations/${pend}`)).status).toBe(403);
    expect((await call(a.stub, staff, ws, 'GET', '/conversations')).status).toBe(200);
    expect(await invitation(ws, pend)).toMatchObject({ status: 'pending' });
  });
});
