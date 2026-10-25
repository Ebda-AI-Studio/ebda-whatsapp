import { createExecutionContext, env } from 'cloudflare:test';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { beforeSharedSend, isActiveMember, joinShared, leaveShared, registerPlatformNumber, sharedPackageAllowed } from '../src/core/shared/shared-number';
import { apiFor, storeId as W0, tokenFor, useApiKey } from './helpers/api';
import { workspace } from './helpers/workspace';

useApiKey();
const W = (n: number) => W0(9800 + n);
const PLAT = '5559001';
const DAY = 86_400_000;
const ON = { SHARED_NUMBER_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
const envOn = { ...env, ...ON } as typeof env;
const call = async (ws: string, role: 'owner' | 'staff', method: string, path: string, body?: unknown) => {
  const token = await tokenFor(ws, 3600, role); // no seeding: a workspace the test emptied stays empty
  return worker.fetch(new Request(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), envOn, createExecutionContext());
};
let ver = 10;
const plan = (ws: string, o: { packageId?: string; status?: 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired'; periodEnd?: number } = {}) =>
  workspace(ws).applyEntitlement({ version: ++ver, packageId: o.packageId ?? 'gold', status: o.status ?? 'active', periodStart: Date.now() - DAY, periodEnd: o.periodEnd ?? Date.now() + 30 * DAY });
const noPlan = async (ws: string) => { await runInDurableObject(workspace(ws), (_i, s) => { s.storage.sql.exec('DELETE FROM entitlements'); }); };
const members = (ws: string) => env.DB.prepare("SELECT status FROM shared_number_members WHERE workspace_id = ?").bind(ws).all().then((x) => x.results);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)"),
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('lite', 'Lite', 10000, 50, 1, 1)"),
    env.DB.prepare("UPDATE packages SET shared_number = 0 WHERE id = 'lite'"),
  ]);
  await registerPlatformNumber(envOn, { phoneNumberId: PLAT, wabaId: '4449001', displayPhone: '+20 100 555 9001', actor: 'op', reason: 'setup for the gating tests' });
});

describe('joining the shared number needs a package that includes it', () => {
  it('no entitlement on record: 402 package_required, nothing written', async () => {
    const ws = W(1);
    await apiFor(ws);
    await noPlan(ws);
    const res = await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: 'Gating One' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'package_required' });
    expect(await members(ws)).toEqual([]);
  });

  it.each([
    ['active', 'gold', 200], ['trialing', 'gold', 200], ['past_due', 'gold', 402], ['cancelled', 'gold', 402], ['expired', 'gold', 402],
  ] as const)('a %s plan on %s answers %i', async (status, packageId, want) => {
    const ws = W(10 + ['active', 'trialing', 'past_due', 'cancelled', 'expired'].indexOf(status));
    await apiFor(ws);
    await plan(ws, { status, packageId });
    const res = await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: `Plan ${status}` });
    expect(res.status).toBe(want);
    if (want === 402) expect(await members(ws)).toEqual([]);
  });

  it('a plan whose period has ended, a package without the flag, and a package the control plane does not know are all refused', async () => {
    const a = W(20);
    await apiFor(a);
    await plan(a, { periodEnd: Date.now() - 1000 });
    expect((await call(a, 'owner', 'POST', '/shared-number/join', { displayName: 'Ended Plan' })).status).toBe(402);
    const b = W(21);
    await apiFor(b);
    await plan(b, { packageId: 'lite' });
    expect((await call(b, 'owner', 'POST', '/shared-number/join', { displayName: 'Lite Plan' })).status).toBe(402);
    const c = W(22);
    await apiFor(c);
    await plan(c, { packageId: 'ghost' });
    expect((await call(c, 'owner', 'POST', '/shared-number/join', { displayName: 'Ghost Plan' })).status).toBe(402);
  });

  it('the included store package and every existing package row default to including it (migration 0012)', async () => {
    expect(await env.DB.prepare("SELECT shared_number FROM packages WHERE id = 'store-included'").first()).toEqual({ shared_number: 1 });
    expect(await env.DB.prepare("SELECT shared_number FROM packages WHERE id = 'gold'").first()).toEqual({ shared_number: 1 });
    const ws = W(23);
    await apiFor(ws);
    await plan(ws, { packageId: 'store-included' });
    expect((await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: 'Included Store' })).status).toBe(200);
  });

  it('staff are still refused (403), a staff token never reaches the package check, and GET says when a package is the reason', async () => {
    const ws = W(24);
    await apiFor(ws);
    await noPlan(ws);
    expect((await call(ws, 'staff', 'POST', '/shared-number/join', {})).status).toBe(403);
    expect(await (await call(ws, 'owner', 'GET', '/shared-number')).json()).toMatchObject({ available: true, member: false, packageRequired: true });
    await plan(ws);
    expect(await (await call(ws, 'owner', 'GET', '/shared-number')).json()).toMatchObject({ packageRequired: false });
  });

  it('leaving and joining again goes through the same gate', async () => {
    const ws = W(25);
    await apiFor(ws);
    await plan(ws);
    expect((await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: 'Comes Back' })).status).toBe(200);
    expect((await call(ws, 'owner', 'POST', '/shared-number/leave')).status).toBe(200);
    await plan(ws, { status: 'cancelled' });
    expect((await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: 'Comes Back' })).status).toBe(402);
    expect(await sharedPackageAllowed(envOn, ws)).toBe(false);
    expect(await joinShared(envOn, ws, 'Comes Back')).toBe('package_required');
  });
});

describe('a member whose plan lapses keeps receiving and replying, but cannot start conversations', () => {
  const job = (ws: string, kind: 'text' | 'template') => ({ workspaceId: ws, phoneNumberId: PLAT, to: '201001234567', kind, ...(kind === 'text' ? { text: 'hi' } : { template: { name: 't', language: 'ar', components: [] } }) }) as never;

  it('stays an active member (inbound keeps routing), may send a free-text reply, may not send a template', async () => {
    const ws = W(30);
    await apiFor(ws);
    await plan(ws);
    expect((await call(ws, 'owner', 'POST', '/shared-number/join', { displayName: 'Lapsing Shop' })).status).toBe(200);
    expect(await beforeSharedSend(envOn, job(ws, 'template'))).toBe('shared');
    await plan(ws, { status: 'past_due' });
    expect(await isActiveMember(envOn, ws, PLAT)).toBe(true); // membership and inbound routing are untouched
    expect(await beforeSharedSend(envOn, job(ws, 'text'))).toBe('shared'); // a reply
    expect(await beforeSharedSend(envOn, job(ws, 'template'))).toBe('lapsed'); // a new conversation
    await plan(ws, { status: 'active' });
    expect(await beforeSharedSend(envOn, job(ws, 'template'))).toBe('shared');
  });
});
