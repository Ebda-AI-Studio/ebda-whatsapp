import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRoutes } from '../src/index';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, adminToken, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { openChat, own, rows } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const W = (n: number) => W0(3100 + n);
const A = '201001234567';
const B = '201007654321';

/** A super admin with NO membership in the store, calling a STORE route. */
async function asSuperAdmin(ws: string, method: string, path: string, body?: unknown) {
  const token = await adminToken();
  return SELF.fetch(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

describe('STORE-ROUTES-OWNER-1: every store-route write is the member\'s; an operator uses the operator routes', () => {
  it('a super admin gets 403 on the named personal-data / retention writes, and nothing changes', async () => {
    const ws = W(1);
    await own(ws);
    await openChat(ws, A);
    await openChat(ws, B);
    for (const [method, path, body] of [
      ['PUT', '/retention', { days: 30 }], ['DELETE', `/contacts/${A}`], ['POST', '/contacts/merge', { fromWaId: A, intoWaId: B }], ['PATCH', `/contacts/${A}`, { name: 'x' }],
    ] as const) {
      const r = await asSuperAdmin(ws, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await (await apiFor(ws, 'staff')).call('DELETE', `/contacts/${A}`)).status).toBe(403); // a staff member neither
    expect(await rows(ws, 'SELECT wa_id FROM contacts ORDER BY id')).toEqual([{ wa_id: A }, { wa_id: B }]);
    expect(await (await (await apiFor(ws)).call('GET', '/retention')).json()).toMatchObject({ days: null });
  });

  it('WALK: every registered store WRITE route (POST/PUT/PATCH/DELETE under /stores/:storeId) refuses a super admin who is not a member', async () => {
    const ws = W(2);
    await own(ws);
    const writes = apiRoutes.routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/stores/:storeId/'));
    expect(writes.length).toBeGreaterThan(40);
    const open: string[] = [];
    for (const r of writes) {
      const path = r.path.replace('/stores/:storeId', '').replace(/:[A-Za-z]+(\{[^}]*\})?/g, '1');
      const res = await asSuperAdmin(ws, r.method, path, {});
      if (res.status !== 403) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('the member still can (owner erase, retention)', async () => {
    const ws = W(3);
    await own(ws);
    await openChat(ws, A);
    const owner = await apiFor(ws);
    expect((await owner.call('PUT', '/retention', { days: 90 })).status).toBe(200);
    expect((await owner.call('DELETE', `/contacts/${A}`)).status).toBe(200);
  });

  it('the operator erase route needs a reason, erases, audits, and keeps the reason in audit_reasons only', async () => {
    const ws = W(4);
    await own(ws);
    await openChat(ws, A);
    const path = `/workspaces/${ws}/contacts/${A}`;
    expect((await operatorCall(OP1, 'DELETE', path, {})).status).toBe(400);
    expect((await operatorCall(null, 'DELETE', path, { reason: 'data subject asked in writing' })).status).toBe(401);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toHaveLength(1);
    const ok = await operatorCall(OP1, 'DELETE', path, { reason: 'data subject asked in writing, case 4412' });
    expect(ok.status).toBe(200);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM erasure_records WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(1); // the erasure record is written like the owner's
    const kept = await env.DB.prepare('SELECT actor, reason FROM audit_reasons WHERE workspace_id = ?').bind(ws).all<{ actor: string; reason: string }>();
    expect(kept.results).toEqual([{ actor: OP1, reason: 'data subject asked in writing, case 4412' }]);
    const logged = await env.DB.prepare("SELECT detail, target_id FROM audit_log WHERE workspace_id = ? AND action LIKE 'DELETE /operator/%'").bind(ws).all<{ detail: string | null; target_id: string | null }>();
    expect(JSON.stringify(logged.results)).not.toMatch(/case 4412|2010/);
    expect((await operatorCall(OP1, 'DELETE', `/workspaces/${W(5)}/contacts/${A}`, { reason: 'data subject asked in writing' })).status).toBe(404); // unknown workspace
  });
});
