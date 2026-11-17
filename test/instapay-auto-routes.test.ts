import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signBridge } from '../foundation/instapay-digest';
import { autoConfirmInstapay, getAutoMode, workspaceAutoEnabled } from '../src/core/billing/instapay-auto';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { aiEnv, autoRow, goodAnswer, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { rows } from './helpers/workspace';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9900 + n);
const SECRET = 'test-bridge-secret-0123456789';
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const tapCall = async (body: unknown, o: { secret?: string; ts?: number; dir?: 'notify' | 'revert'; sig?: string } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = o.ts ?? Date.now();
  const sig = o.sig ?? (await signBridge(o.secret ?? SECRET, raw, ts, o.dir ?? 'revert'));
  return SELF.fetch('https://x/internal/instapay/auto-confirm/not-received', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Bridge-Ts': String(ts), 'X-Bridge-Sig': sig }, body: raw });
};
const autoTopup = async (ws: string) => {
  await seedSub(ws);
  const r = await request(ws, 'topup');
  await setMode('live');
  expect((await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id)).state).toBe('auto_confirmed');
  return r;
};
const walletBal = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM wallet_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;

describe('C6: the signed "not received" endpoint', () => {
  it('a bad, missing, stale, wrong-direction or wrong-secret signature is 401 with ZERO writes', async () => {
    const ws = W(1);
    const r = await autoTopup(ws);
    const body = { id: r.id, actor: 'telegram-owner', tappedAt: Date.now() };
    for (const res of [
      await tapCall(body, { sig: 'f'.repeat(64) }),
      await tapCall(body, { sig: '' }),
      await tapCall(body, { ts: Date.now() - 6 * 60_000 }),
      await tapCall(body, { dir: 'notify' }), // a captured digest signature can never revert
      await tapCall(body, { secret: 'another-secret-0123456789' }),
    ]) expect(res.status).toBe(401);
    expect((await autoRow(r.id))!.state).toBe('auto_confirmed');
    expect(await walletBal(ws)).toBe(20_000);
  });

  it('a valid tap reverts once; a replay of the same signed request is 200 already_reverted; unknown id 404; a non-auto payment 409; bad body 400', async () => {
    const ws = W(2);
    const r = await autoTopup(ws);
    const body = JSON.stringify({ id: r.id, actor: 'telegram-owner', tappedAt: Date.now() });
    const ts = Date.now();
    const sig = await signBridge(SECRET, body, ts, 'revert');
    const first = await tapCall(body, { ts, sig });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: 'reverted' });
    const replay = await tapCall(body, { ts, sig });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ result: 'already_reverted' });
    expect(await walletBal(ws)).toBe(0);
    expect((await tapCall({ id: 'nope', actor: 'a', tappedAt: 1 })).status).toBe(404);
    const n = await request(ws, 'topup');
    await autoConfirmInstapay(aiEnv('throw'), n.id);
    const conflict = await tapCall({ id: n.id, actor: 'a', tappedAt: 1 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'NOT_AUTO_CONFIRMED' });
    expect((await tapCall({ id: r.id, extra: 1 })).status).toBe(400);
  });
});

describe('C6: operator controls (super admin)', () => {
  it('mode and workspace switches need a reason, take effect on the very next decision with no deploy, and are audited', async () => {
    const ws = W(3);
    await seedSub(ws);
    expect((await operatorCall(OP1, 'PUT', '/instapay/auto/mode', { mode: 'live', reason: 'no' })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', '/instapay/auto/mode', { mode: 'shadow', reason: 'start shadow week' })).status).toBe(200);
    expect(await getAutoMode(env)).toBe('shadow');
    const a = await request(ws, 'topup');
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), a.id)).reasons).toEqual(['SHADOW_MODE']);
    expect((await operatorCall(OP1, 'PUT', '/instapay/auto/mode', { mode: 'live', reason: 'go live for the test' })).status).toBe(200);
    expect((await operatorCall(OP1, 'PUT', `/instapay/auto/workspaces/${ws}`, { enabled: false, reason: 'money dispute' })).status).toBe(200);
    expect(await workspaceAutoEnabled(env, ws)).toBe(false);
    const b = await request(ws, 'topup');
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), b.id)).reasons).toEqual(['KILL_STORE']);
    await operatorCall(OP1, 'PUT', `/instapay/auto/workspaces/${ws}`, { enabled: true, reason: 'dispute resolved' });
    const c = await request(ws, 'topup');
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), c.id)).state).toBe('auto_confirmed');
    await operatorCall(OP1, 'PUT', '/instapay/auto/mode', { mode: 'off', reason: 'kill switch drill' });
    const d = await request(ws, 'topup');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), d.id)).toEqual({ state: 'needs_human', reasons: ['KILL_GLOBAL'] });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action IN ('instapay_auto_mode_changed','instapay_auto_workspace_toggled')").first<{ n: number }>();
    expect(n!.n).toBeGreaterThanOrEqual(5);
  });

  it('list shows verdicts and reasons; revert needs a reason; a non-super-admin and an anonymous caller are refused', async () => {
    const ws = W(4);
    const r = await autoTopup(ws);
    const list = (await (await operatorCall(OP1, 'GET', '/instapay/auto')).json()) as { mode: string; ready: { ready: boolean }; items: Array<{ requestId: string; state: string; reasons: string[] }> };
    expect(list.mode).toBe('live');
    expect(list.items.find((i) => i.requestId === r.id)).toMatchObject({ state: 'auto_confirmed', reasons: [] });
    expect((await operatorCall(OP1, 'POST', `/instapay/auto/${r.id}/revert`, { reason: 'x' })).status).toBe(400);
    const ok = await operatorCall(OP1, 'POST', `/instapay/auto/${r.id}/revert`, { reason: 'bank shows nothing' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: 'reverted', creditsRemovedMinor: 20_000 });
    expect((await operatorCall(OP1, 'POST', `/instapay/auto/${r.id}/revert`, { reason: 'bank shows nothing' })).status).toBe(200); // replay
    expect((await operatorCall(OP1, 'POST', '/instapay/auto/nope/revert', { reason: 'bank shows nothing' })).status).toBe(404);
    expect((await operatorCall(null, 'GET', '/instapay/auto')).status).toBe(401);
    expect((await reqRow(r.id))!.reverted_at).not.toBeNull();
  });
});
