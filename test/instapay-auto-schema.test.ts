import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { D1DuplicateIndex, duplicateIndexContract, type D1Like } from '../foundation/instapay-dedupe';
import { getAutoMode, getDuplicateIndex, instapayAutoReady, setAutoMode, setWorkspaceAuto, workspaceAutoEnabled } from '../src/core/billing/instapay-auto';

describe('C1: schema, switches, readiness', () => {
  it('mode defaults to off and a workspace is on until a row says otherwise', async () => {
    expect(await getAutoMode(env)).toBe('off');
    expect(await workspaceAutoEnabled(env, 'ws-never-seen')).toBe(true);
  });
  it('a switch needs a reason of 5+ characters, takes effect on the very next read, and is audited', async () => {
    expect(await setAutoMode(env, { mode: 'shadow', actor: 'op-1', reason: 'no' })).toEqual({ ok: false, reason: 'reason_required' });
    expect(await setAutoMode(env, { mode: 'bogus', actor: 'op-1', reason: 'a valid reason' })).toEqual({ ok: false, reason: 'invalid_mode' });
    expect(await getAutoMode(env)).toBe('off');
    expect(await setAutoMode(env, { mode: 'shadow', actor: 'op-1', reason: 'start the shadow week' })).toEqual({ ok: true });
    expect(await getAutoMode(env)).toBe('shadow');
    expect(await setWorkspaceAuto(env, { workspaceId: 'ws-sw-1', enabled: false, actor: 'op-1', reason: 'money dispute' })).toEqual({ ok: true });
    expect(await workspaceAutoEnabled(env, 'ws-sw-1')).toBe(false);
    await setWorkspaceAuto(env, { workspaceId: 'ws-sw-1', enabled: true, actor: 'op-1', reason: 'dispute resolved' });
    expect(await workspaceAutoEnabled(env, 'ws-sw-1')).toBe(true);
    const audited = await env.DB.prepare("SELECT action FROM billing_audit WHERE action IN ('instapay_auto_mode_changed', 'instapay_auto_workspace_toggled')").all<{ action: string }>();
    expect(audited.results.map((r) => r.action)).toEqual(expect.arrayContaining(['instapay_auto_mode_changed', 'instapay_auto_workspace_toggled']));
    await setAutoMode(env, { mode: 'off', actor: 'op-1', reason: 'back to the default' });
  });
  it('request_id is UNIQUE and so is the idempotency key', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('ws-uq', 'ws-uq', 0)").run();
    await env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, currency, state, created_by, created_at, expires_at) VALUES ('req-uq', 'WA-UQ', 'ws-uq', 'topup', 1000, 'EGP', 'under_review', 'u', 0, 1)").run();
    const ins = (id: string, key: string) => env.DB.prepare("INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, idempotency_key, created_at, updated_at) VALUES (?, 'req-uq', 'ws-uq', 'pending_decision', ?, 0, 0)").bind(id, key).run();
    await ins('a1', 'k1');
    await expect(ins('a2', 'k2')).rejects.toThrow(/UNIQUE/i);
  });
  it('readiness names every missing piece (fail closed)', () => {
    expect(instapayAutoReady(env).missing).not.toContain('INSTAPAY_DEDUPE_DB');
    const bare = { ...env, INSTAPAY_DEDUPE_DB: undefined, INSTAPAY_BRIDGE_SECRET: 'short', BRAIN_BRIDGE_URL: 'http://x', AI: undefined } as unknown as typeof env;
    expect(instapayAutoReady(bare)).toEqual({ ready: false, missing: expect.arrayContaining(['INSTAPAY_DEDUPE_DB', 'INSTAPAY_BRIDGE_SECRET', 'BRAIN_BRIDGE_URL', 'AI']) });
    expect(getDuplicateIndex({ ...env, INSTAPAY_DEDUPE_DB: undefined } as unknown as typeof env)).toBeNull();
  });
});

describe('the shared duplicate index contract, run against the REAL D1 binding', () => {
  let n = 0;
  duplicateIndexContract(async () => {
    await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run();
    n++;
    return new D1DuplicateIndex(env.INSTAPAY_DEDUPE_DB as unknown as D1Like);
  }, { it: (name, fn) => it(`[${n}] ${name}`, fn), expect: expect as never });
});
