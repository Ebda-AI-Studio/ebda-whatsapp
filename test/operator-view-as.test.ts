import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OP1, adminToken, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { openChat } from './helpers/workspace';

// T35: an operator can look at a merchant's workspace "as the merchant" to help them, READ-ONLY and AUDITED. The operator sends X-View-As-Merchant: 1 and a reason; every
// request is written to operator_view_log BEFORE it is served (no audit, no view), writes and sockets are refused, and the log holds no body, query string or phone.
useApiKey();
const REASON = 'merchant asked why campaigns are paused (ticket 123)';
const view = async (ws: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  SELF.fetch(`https://x/api/v1/stores/${ws}${path}`, {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${await adminToken(OP1)}`, 'x-view-as-merchant': '1', 'x-view-as-reason': REASON, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
const log = (ws: string) => env.DB.prepare('SELECT at, actor, workspace_id, method, route, reason FROM operator_view_log WHERE workspace_id = ? ORDER BY id').bind(ws).all<{ at: number; actor: string; workspace_id: string; method: string; route: string; reason: string }>().then((r) => r.results);

describe('reading as the merchant', () => {
  it('an operator reads the merchant\'s inbox, and each read is in the audit log with who, which workspace, which route and why', async () => {
    const ws = W(9900);
    await apiFor(ws);
    await openChat(ws, '201001234567', { text: 'hi', wamid: 'wamid.va.1', ts: Math.floor(Date.now() / 1000) });
    const before = Date.now();
    const res = await view(ws, '/conversations?limit=10');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    const rows = await log(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: OP1, workspace_id: ws, method: 'GET', route: `/stores/${ws}/conversations`, reason: REASON });
    expect(rows[0]!.at).toBeGreaterThanOrEqual(before);
  });

  it('the log keeps no query string, no body and no phone number (a phone in the path is masked)', async () => {
    const ws = W(9901);
    await apiFor(ws);
    await view(ws, '/contacts/201001234567/orders?token=SECRET&x=1');
    const rows = await log(ws);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/201001234567|SECRET|x=1/);
    expect(rows[0]!.route).toBe(`/stores/${ws}/contacts/:id/orders`);
  });

  it('a reason is required: missing or too short is 400 and nothing is read or logged', async () => {
    const ws = W(9902);
    await apiFor(ws);
    for (const h of [{ 'x-view-as-reason': '' }, { 'x-view-as-reason': 'help' }, { 'x-view-as-reason': 'x'.repeat(201) }]) {
      const res = await view(ws, '/conversations', { headers: h });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_request', message: 'view_as_reason_required' });
    }
    expect(await log(ws)).toEqual([]);
  });

  it('no audit, no view: when the audit row cannot be written the read is refused with 503 (fail closed)', async () => {
    const ws = W(9903);
    await apiFor(ws);
    const { vi } = await import('vitest');
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation(((sql: string) => (sql.includes('INSERT INTO operator_view_log') ? { bind: () => ({ run: async () => { throw new Error('d1 down'); } }) } : real(sql))) as never);
    const res = await view(ws, '/conversations');
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'view_as_audit_unavailable' });
  });
});

describe('it is read-only', () => {
  it('every write is 403 view_as_read_only, whatever the route, and the refusal is logged too', async () => {
    const ws = W(9904);
    await apiFor(ws);
    for (const [method, path, body] of [
      ['POST', '/conversations/1/messages', { type: 'text', clientId: crypto.randomUUID(), text: 'x' }],
      ['PUT', '/agent', { enabled: true }],
      ['DELETE', '/contacts/201001234567', undefined],
      ['POST', '/wallet/topups', { amountMinor: 5000 }],
      ['PUT', '/digest', { enabled: false }],
    ] as const) {
      const res = await view(ws, path, { method, ...(body !== undefined ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ message: 'view_as_read_only' });
    }
    expect((await log(ws)).filter((r) => r.method !== 'GET')).toHaveLength(5);
  });

  it('a live socket is refused (it would outlive the audit of the single request)', async () => {
    const ws = W(9905);
    await apiFor(ws);
    const res = await view(ws, '/ws', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(403);
  });

  it('without the header an operator behaves exactly as before (the merchant app and the operator console are unchanged)', async () => {
    const ws = W(9906);
    await apiFor(ws);
    const res = await SELF.fetch(`https://x/api/v1/stores/${ws}/conversations`, { headers: { authorization: `Bearer ${await adminToken(OP1)}` } });
    expect(res.status).toBe(200);
    expect(await log(ws)).toEqual([]);
  });

  it('only an operator may use it: a merchant owner sending the header is refused and nothing is logged', async () => {
    const ws = W(9907);
    const api = await apiFor(ws, 'owner');
    const res = await api.call('GET', '/conversations', undefined, { 'x-view-as-merchant': '1', 'x-view-as-reason': REASON });
    expect(res.status).toBe(403);
    expect(await log(ws)).toEqual([]);
  });
});

describe('reading the audit', () => {
  it('GET /operator/view-log lists a workspace\'s views newest first; the log is append-only', async () => {
    const ws = W(9908);
    await apiFor(ws);
    await view(ws, '/conversations');
    await view(ws, '/wallet');
    const r = await operatorCall(OP1, 'GET', `/view-log?workspaceId=${ws}`);
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: { route: string; actor: string }[] }).items;
    expect(items.map((i) => i.route)).toEqual([`/stores/${ws}/wallet`, `/stores/${ws}/conversations`]);
    await expect(env.DB.prepare('UPDATE operator_view_log SET reason = ?').bind('x').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM operator_view_log').run()).rejects.toThrow(/append-only/);
  });
});
