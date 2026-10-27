import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAudit } from '../src/core/audit';
import { AUDIT_RETENTION_YEARS, purgeAuditStatements } from '../src/core/ops/audit-retention';
import { configureSessionCheck } from '../src/core/identity/session';
import { runDueOffboardings, pseudonymFor } from '../src/core/ops/offboarding';
import { OP1, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { openChat, own } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const W = (n: number) => W0(2900 + n);
const YEAR = 365 * 86_400_000;
type Row = { id: number; at: number; workspace_id: string | null; actor: string; actor_role: string; action: string; target_type: string | null; target_id: string | null; detail: string | null; status: number };
const log = (ws: string) => env.DB.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id').bind(ws).all<Row>().then((r) => r.results);
const triggers = () => env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log' ORDER BY name").all<{ name: string }>().then((r) => r.results.map((x) => x.name));

describe('item 6: no free text in the append-only audit_log', () => {
  it('an operator export keeps its reason in audit_reasons (deletable), never in audit_log.detail', async () => {
    const ws = W(1);
    await own(ws);
    await openChat(ws, '201001234567');
    const r = await operatorCall(OP1, 'GET', `/workspaces/${ws}/contacts/201001234567/export?reason=${encodeURIComponent('subject called from 201009998877 asking for a copy')}`);
    expect(r.status).toBe(200);
    const rows = await log(ws);
    const exp = rows.find((x) => x.action === 'contact.export')!;
    expect(exp.detail).not.toMatch(/reason|subject called|2010/);
    expect(JSON.parse(exp.detail!)).toEqual({ messages: expect.any(Number), after: 0 });
    const kept = await env.DB.prepare('SELECT actor, action, reason FROM audit_reasons WHERE workspace_id = ?').bind(ws).all<{ actor: string; action: string; reason: string }>();
    expect(kept.results).toEqual([{ actor: OP1, action: 'contact.export', reason: 'subject called from 201009998877 asking for a copy' }]);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM audit_log').all())).not.toMatch(/2010\d{7}/); // the append-only log never sees it
  });

  it('recordAudit drops a detail key named reason / note / text / message / body, so a new caller cannot put free text there', async () => {
    const ws = W(2);
    await recordAudit(env, { workspaceId: ws, actor: 'u', role: 'system', action: 'x.test', detail: { reason: 'call me on 201001234567', note: 'n', text: 't', message: 'm', body: 'b', count: 3 } });
    expect(JSON.parse((await log(ws))[0]!.detail!)).toEqual({ count: 3 });
  });

  it('the reasons are deleted with the workspace (offboarding)', async () => {
    const ws = W(3);
    await own(ws);
    await env.DB.prepare("INSERT INTO audit_reasons (at, workspace_id, actor, action, reason) VALUES (1, ?, 'op', 'contact.export', 'r')").bind(ws).run();
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: 'legal request by e-mail', immediate: true });
    await runDueOffboardings(env, Date.now() + 1000);
    expect(await env.DB.prepare('SELECT 1 FROM audit_reasons WHERE workspace_id = ?').bind(ws).all().then((r) => r.results)).toEqual([]);
  });
});

describe('item 12 (AUDIT-RETENTION-1): actor ids are pseudonymised on offboarding; rows past the retention are purged by one controlled batch', () => {
  it('after a deletion the merchant users in audit_log carry the money tables\' pseudonym, operators stay, and the append-only triggers are intact', async () => {
    const ws = W(10);
    await own(ws);
    await recordAudit(env, { workspaceId: ws, actor: 'user-owner-1', role: 'owner', action: 'POST /stores/:storeId/x' });
    await recordAudit(env, { workspaceId: ws, actor: 'user-staff-1', role: 'staff', action: 'POST /stores/:storeId/y' });
    await recordAudit(env, { workspaceId: ws, actor: OP1, role: 'operator', action: 'POST /operator/z' });
    await recordAudit(env, { workspaceId: ws, actor: 'client:abc', role: 'integration', action: 'POST /stores/:storeId/w' });
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: 'legal request by e-mail', immediate: true });
    await runDueOffboardings(env, Date.now() + 1000);
    const pseudo = (await pseudonymFor(env, ws))!;
    const rows = await log(ws);
    expect(rows.filter((r) => r.actor_role === 'owner' || r.actor_role === 'staff').map((r) => r.actor)).toEqual([pseudo, pseudo]);
    expect([...new Set(rows.filter((r) => r.actor_role === 'operator').map((r) => r.actor))]).toEqual([OP1]);
    expect(rows.filter((r) => r.actor_role === 'integration').map((r) => r.actor)).toEqual(['client:abc']);
    expect(await triggers()).toEqual(['audit_log_no_delete', 'audit_log_no_update']);
    await expect(env.DB.prepare("UPDATE audit_log SET actor = 'x' WHERE id = 1").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_log WHERE id = 1').run()).rejects.toThrow(/append-only/);
  });

  it('the purge SQL deletes only rows older than the retention, records its own entry in the same batch, and re-creates both triggers', async () => {
    const ws = W(11);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO audit_log (at, workspace_id, actor, actor_role, action) VALUES (?, ?, 'u', 'owner', 'old.one')").bind(now - (AUDIT_RETENTION_YEARS + 1) * YEAR, ws),
      env.DB.prepare("INSERT INTO audit_log (at, workspace_id, actor, actor_role, action) VALUES (?, ?, 'u', 'owner', 'recent.one')").bind(now - (AUDIT_RETENTION_YEARS - 1) * YEAR, ws),
    ]);
    const res = await env.DB.batch(purgeAuditStatements(env, { actor: OP1, reason: 'yearly purge per AUDIT-RETENTION-1', now }));
    expect(res.length).toBeGreaterThan(3);
    expect((await log(ws)).map((r) => r.action)).toEqual(['recent.one']);
    expect(await triggers()).toEqual(['audit_log_no_delete', 'audit_log_no_update']);
    const entry = await env.DB.prepare("SELECT b.actor, r.reason FROM billing_audit b JOIN audit_reasons r ON r.id = b.reason_id WHERE b.action = 'audit_log_purged'").first<{ actor: string; reason: string }>();
    expect(entry).toEqual({ actor: OP1, reason: 'yearly purge per AUDIT-RETENTION-1' });
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
  });

  it('a controlled batch that fails halfway leaves the triggers in place (one transaction)', async () => {
    const stmts = purgeAuditStatements(env, { actor: OP1, reason: 'will fail', now: Date.now() });
    const broken = [...stmts.slice(0, 2), env.DB.prepare("INSERT INTO audit_log (at, actor, actor_role, action) VALUES (1, 'u', 'nobody', 'bad')"), ...stmts.slice(2)];
    await expect(env.DB.batch(broken)).rejects.toThrow();
    expect(await triggers()).toEqual(['audit_log_no_delete', 'audit_log_no_update']);
  });

  it('the operator route runs the purge (reason required, super admin only)', async () => {
    expect((await operatorCall(OP1, 'POST', '/audit-log/purge', {})).status).toBe(400);
    expect((await operatorCall(null, 'POST', '/audit-log/purge', { reason: 'yearly purge per AUDIT-RETENTION-1' })).status).toBe(401);
    const ok = await operatorCall(OP1, 'POST', '/audit-log/purge', { reason: 'yearly purge per AUDIT-RETENTION-1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ retentionYears: AUDIT_RETENTION_YEARS });
    expect(await triggers()).toEqual(['audit_log_no_delete', 'audit_log_no_update']);
  });
});

describe('item 13: a write refused by requireStoreAccess is audited too', () => {
  const lastDenied = async (ws: string) => (await log(ws)).filter((r) => r.status === 403).at(-1);
  it('a revoked session, a suspended workspace and a non-member each leave a row (actor, routed pattern, status; no body)', async () => {
    const ws = W(20);
    await own(ws);
    const conv = await openChat(ws);
    const api = await apiFor(ws, 'staff');
    // revoked session
    configureSessionCheck(async () => true);
    const revoked = await api.call('POST', `/conversations/${conv}/notes`, { text: 'سر الملاحظة' });
    expect(revoked.status).toBe(403);
    configureSessionCheck(async () => false);
    expect(await lastDenied(ws)).toMatchObject({ action: 'POST /stores/:storeId/conversations/:conversationId/notes', status: 403, actor_role: 'staff', workspace_id: ws });
    expect(JSON.stringify(await log(ws))).not.toContain('سر الملاحظة');
    // suspended workspace
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-10-27' });
    const before = (await log(ws)).length;
    expect((await api.call('POST', `/conversations/${conv}/notes`, { text: 'x' })).status).toBe(403);
    expect((await log(ws)).length).toBe(before + 1);
    expect(await lastDenied(ws)).toMatchObject({ action: 'POST /stores/:storeId/conversations/:conversationId/notes', status: 403 });
    // a user who is not a member of this store
    const other = W(21);
    await own(other);
    const stranger = await apiFor(other, 'owner');
    const r = await SELF.fetch(`https://x/api/v1/stores/${ws}/conversations/${conv}/notes`, { method: 'POST', headers: { authorization: `Bearer ${stranger.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    expect(r.status).toBe(403);
    expect(await lastDenied(ws)).toMatchObject({ status: 403, action: 'POST /stores/:storeId/conversations/:conversationId/notes' });
  });

  it('a denied READ is not audited (volume), and an unauthenticated call has nobody to name', async () => {
    const ws = W(22);
    await own(ws);
    const stranger = await apiFor(W(23), 'owner');
    const get = await SELF.fetch(`https://x/api/v1/stores/${ws}/conversations`, { headers: { authorization: `Bearer ${stranger.token}` } });
    expect(get.status).toBe(403);
    const none = await SELF.fetch(`https://x/api/v1/stores/${ws}/conversations/1/notes`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    expect(await log(ws)).toEqual([]);
  });
});
