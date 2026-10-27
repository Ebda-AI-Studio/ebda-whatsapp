import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/index';
import { OPERATOR_READS_WITHOUT_SESSION_CHECK } from '../src/routes/operator';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, adminToken, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { openChat, own } from './helpers/workspace';

useApiKey();
afterEach(() => configureSessionCheck(null));
type R = { method: string; path: string };
const table = (apiRoutes.routes as R[]).filter((r) => r.path.startsWith('/operator/') && r.method !== 'ALL');
const fill = (p: string) => p.replace(/:[A-Za-z]+/g, 'x');

describe('every operator request checks the session unless its route is explicitly listed (fail closed)', () => {
  it('a revoked operator session cannot export a person\'s data', async () => {
    const ws = W(4201);
    await own(ws);
    await openChat(ws, '201001234567');
    configureSessionCheck(async () => true);
    const r = await operatorCall(OP1, 'GET', `/workspaces/${ws}/contacts/201001234567/export?reason=${encodeURIComponent('طلب كتابي من صاحبة البيانات')}`);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: 'session_revoked' });
    configureSessionCheck(async () => false);
    expect((await operatorCall(OP1, 'GET', `/workspaces/${ws}/contacts/201001234567/export?reason=${encodeURIComponent('طلب كتابي من صاحبة البيانات')}`)).status).toBe(200);
  });

  it('an unreachable accounts service refuses (503) instead of letting the read through', async () => {
    configureSessionCheck(async () => { throw new Error('accounts down'); });
    expect((await operatorCall(OP1, 'GET', '/audit-log')).status).toBe(503);
  });

  it('walks EVERY registered operator route: revoked = 403 session_revoked, except the few listed reads (each with a reason)', async () => {
    expect(table.length).toBeGreaterThan(40);
    configureSessionCheck(async () => true);
    const token = await adminToken(OP1);
    const unguarded: string[] = [];
    for (const r of table) {
      const key = `${r.method} ${r.path}`;
      const res = await SELF.fetch(`https://x/api/v1${fill(r.path)}`, { method: r.method, headers: { authorization: `Bearer ${token}`, ...(r.method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, ...(r.method !== 'GET' ? { body: '{}' } : {}) });
      const revoked = res.status === 403 && ((await res.clone().json().catch(() => ({}))) as { message?: string }).message === 'session_revoked';
      if (key in OPERATOR_READS_WITHOUT_SESSION_CHECK ? revoked : !revoked) unguarded.push(key);
    }
    expect(unguarded, 'routes whose session check does not match the explicit list').toEqual([]);
  });

  it('the explicit list has no stale entries, only GETs, and a reason for each', () => {
    const keys = new Set(table.map((r) => `${r.method} ${r.path}`));
    for (const [k, why] of Object.entries(OPERATOR_READS_WITHOUT_SESSION_CHECK)) {
      expect(keys.has(k), `${k} is not a route`).toBe(true);
      expect(k.startsWith('GET '), k).toBe(true);
      expect(why.length, k).toBeGreaterThan(15);
    }
  });
});

describe('the store export is the owner\'s alone', () => {
  it('a super admin on the store route gets 403 (operators use the operator route, which needs a reason and is audited)', async () => {
    const ws = W(4202);
    await own(ws);
    await openChat(ws, '201001234567');
    const token = await adminToken(OP1);
    const r = await SELF.fetch(`https://x/api/v1/stores/${ws}/contacts/201001234567/export`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
    expect((await (await apiFor(ws)).call('GET', '/contacts/201001234567/export')).status).toBe(200);
  });

  it('a revoked OWNER session cannot export either (the store middleware checks this read like a write)', async () => {
    const ws = W(4203);
    await own(ws);
    await openChat(ws, '201001234567');
    const owner = await apiFor(ws);
    configureSessionCheck(async () => true);
    const r = await owner.call('GET', '/contacts/201001234567/export');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: 'session_revoked' });
    void env;
  });
});
