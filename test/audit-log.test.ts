import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { openChat, own } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

type Row = { id: number; at: number; workspace_id: string | null; actor: string; actor_role: string; action: string; target_type: string | null; target_id: string | null; detail: string | null; status: number };
const log = (ws: string) => env.DB.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id').bind(ws).all<Row>().then((r) => r.results);

describe('audit_log: who did what, to which id, when', () => {
  it('a staff write is recorded with workspace, actor, role, route and target ids, and never a body', async () => {
    const ws = W(3101);
    await own(ws);
    const conv = await openChat(ws);
    const staff = await apiFor(ws, 'staff');
    const before = Date.now();
    const r = await staff.call('POST', `/conversations/${conv}/notes`, { text: 'سر الملاحظة الخاصة' });
    expect(r.status).toBeLessThan(300);
    const rows = await log(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: ws, actor_role: 'staff', action: 'POST /stores/:storeId/conversations/:conversationId/notes', target_type: 'conversationId', target_id: String(conv), status: r.status });
    expect(rows[0]!.at).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(rows)).not.toContain('سر الملاحظة');
  });

  it('reads, message sends and mark-read are not audited (volume), a denied write (403) is', async () => {
    const ws = W(3102);
    await own(ws);
    const conv = await openChat(ws);
    const staff = await apiFor(ws, 'staff');
    await staff.call('GET', '/conversations');
    await staff.call('POST', `/conversations/${conv}/read`);
    await staff.call('POST', `/conversations/${conv}/messages`, { type: 'text', clientId: crypto.randomUUID(), text: 'hello' });
    expect(await log(ws)).toEqual([]);
    const denied = await staff.call('DELETE', '/contacts/201001234567'); // owner only
    expect(denied.status).toBe(403);
    const rows = await log(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'DELETE /stores/:storeId/contacts/:waId', status: 403 });
  });

  it('a phone number never reaches the log: a contact erasure targets the keyed hash', async () => {
    const ws = W(3103);
    await own(ws);
    await openChat(ws, '201001234567');
    const owner = await apiFor(ws);
    expect((await owner.call('DELETE', '/contacts/201001234567')).status).toBe(200);
    const all = await env.DB.prepare('SELECT * FROM audit_log').all();
    const text = JSON.stringify(all.results);
    expect(text).not.toMatch(/2010\d{7}/);
    const row = (await log(ws)).find((r) => r.action.startsWith('DELETE /stores/:storeId/contacts'))!;
    expect(row.target_type).toBe('waId');
    expect(row.target_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('operator actions are recorded with the operator as actor', async () => {
    const ws = W(3104);
    await own(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-10-27' })).status).toBe(200);
    const rows = await log(ws);
    expect(rows.at(-1)).toMatchObject({ actor: OP1, actor_role: 'operator', action: 'POST /operator/workspaces/:workspaceId/suspend', workspace_id: ws });
    expect(JSON.stringify(rows)).not.toContain('abuse report'); // the reason lives in operator_actions, not copied here
  });

  it('is append-only', async () => {
    const ws = W(3105);
    await own(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-10-27' });
    await expect(env.DB.prepare("UPDATE audit_log SET actor = 'x' WHERE workspace_id = ?").bind(ws).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_log WHERE workspace_id = ?').bind(ws).run()).rejects.toThrow(/append-only/);
  });

  it('a failing audit write never breaks the request, and raises a P1 alert', async () => {
    const ws = W(3106);
    await own(ws);
    const conv = await openChat(ws);
    const staff = await apiFor(ws, 'staff');
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO audit_log')) throw new Error('d1 down');
      return real(sql);
    });
    const warn = vi.spyOn(console, 'error');
    const r = await staff.call('POST', `/conversations/${conv}/notes`, { text: 'x' });
    expect(r.status).toBeLessThan(300);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('audit_write_failed'))).toBe(true);
  });
});

describe('GET /operator/audit-log', () => {
  it('super admin only; filters by workspace, actor and action; newest first; pages with before', async () => {
    const ws = W(3110);
    await own(ws);
    const owner = await apiFor(ws);
    const conv = await openChat(ws);
    for (let i = 0; i < 3; i++) await owner.call('POST', `/conversations/${conv}/notes`, { text: `n${i}` });
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-10-27' });
    const asOwner = await SELF.fetch(`https://x/api/v1/operator/audit-log?workspaceId=${ws}`, { headers: { authorization: `Bearer ${owner.token}` } });
    expect(asOwner.status).toBe(403);
    expect((await operatorCall(null, 'GET', `/audit-log?workspaceId=${ws}`)).status).toBe(401);

    const all = (await (await operatorCall(OP1, 'GET', `/audit-log?workspaceId=${ws}`)).json()) as { items: Row[] };
    expect(all.items.length).toBe(4);
    expect(all.items.map((i) => i.id)).toEqual([...all.items.map((i) => i.id)].sort((a, b) => b - a));
    const byActor = (await (await operatorCall(OP1, 'GET', `/audit-log?workspaceId=${ws}&actor=${OP1}`)).json()) as { items: Row[] };
    expect(byActor.items.map((i) => i.actor)).toEqual([OP1]);
    const byAction = (await (await operatorCall(OP1, 'GET', `/audit-log?workspaceId=${ws}&action=${encodeURIComponent('POST /stores/:storeId/conversations/:conversationId/notes')}`)).json()) as { items: Row[] };
    expect(byAction.items).toHaveLength(3);
    const page1 = (await (await operatorCall(OP1, 'GET', `/audit-log?workspaceId=${ws}&limit=2`)).json()) as { items: Row[] };
    expect(page1.items).toHaveLength(2);
    const page2 = (await (await operatorCall(OP1, 'GET', `/audit-log?workspaceId=${ws}&limit=2&before=${page1.items[1]!.id}`)).json()) as { items: Row[] };
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.id).toBeLessThan(page1.items[1]!.id);
    expect((await operatorCall(OP1, 'GET', '/audit-log?limit=0')).status).toBe(400);
  });
});
