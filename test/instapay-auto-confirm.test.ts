import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoConfirmInstapay } from '../src/core/billing/instapay-auto';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiCalls, aiEnv, autoRow, events, goodAnswer, request, reqRow, seedGold, seedSub, sessionOk, setMode, HOUR } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { rows } from './helpers/workspace';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9700 + n);
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const walletBalance = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM wallet_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;
const aiBalance = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM credit_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;

describe('C3: decide and confirm', () => {
  it('top-up, full match, live: confirmed by the system, wallet credited once, row auto_confirmed; a replay changes nothing', async () => {
    const ws = W(1);
    await seedSub(ws);
    const r = await request(ws, 'topup', { amountMinor: 20_000 });
    await setMode('live');
    const e = aiEnv(goodAnswer(20_000));
    expect(await autoConfirmInstapay(e, r.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
    expect(await reqRow(r.id)).toMatchObject({ state: 'confirmed', decided_by: 'system:auto-confirm' });
    expect((await reqRow(r.id))!.granted_at).not.toBeNull();
    expect(await walletBalance(ws)).toBe(20_000);
    expect(await autoRow(r.id)).toMatchObject({ state: 'auto_confirmed', verdict: 'auto_confirm', is_first_payment: 1, amount_minor: 20_000, expected_amount_minor: 20_000 });
    expect(await autoConfirmInstapay(e, r.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
    expect(aiCalls(e)).toBe(1); // the replay never re-read the proof
    expect(await walletBalance(ws)).toBe(20_000);
    expect(await events(ws)).toBe(1);
  });

  it('package purchase, full match, live: the package is granted once (subscription, AI credits)', async () => {
    const ws = W(2);
    const r = await request(ws, 'package');
    await setMode('live');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000)), r.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
    const sub = await env.DB.prepare('SELECT package_id, status FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first();
    expect(sub).toMatchObject({ package_id: 'gold', status: 'active' });
    expect(await aiBalance(ws)).toBe(300);
    expect(await env.DB.prepare("SELECT owns_running FROM package_orders WHERE order_id = ?").bind(r.id).first()).toMatchObject({ owns_running: 1 });
  });

  it('mode off: nothing is read, the row says KILL_GLOBAL, no model call; shadow: decided but NOT activated, the would-be verdict is kept', async () => {
    const ws = W(3);
    await seedSub(ws);
    const a = await request(ws, 'topup');
    const e = aiEnv(goodAnswer(20_000));
    expect(await autoConfirmInstapay(e, a.id)).toEqual({ state: 'needs_human', reasons: ['KILL_GLOBAL'] });
    expect(aiCalls(e)).toBe(0);
    await setMode('shadow');
    const b = await request(ws, 'topup');
    const e2 = aiEnv(goodAnswer(20_000));
    expect(await autoConfirmInstapay(e2, b.id)).toEqual({ state: 'needs_human', reasons: ['SHADOW_MODE'] });
    expect(await autoRow(b.id)).toMatchObject({ verdict: 'auto_confirm' }); // a person would have confirmed it automatically
    expect((await reqRow(b.id))!.state).toBe('under_review');
    expect(await walletBalance(ws)).toBe(0);
  });

  it('a per-workspace switch off waits for a person even in live mode (no model call)', async () => {
    const ws = W(4);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    await env.DB.prepare('INSERT INTO instapay_auto_workspace (workspace_id, disabled_at, actor, updated_at) VALUES (?, 1, ?, 1)').bind(ws, 'op').run();
    const e = aiEnv(goodAnswer(20_000));
    expect(await autoConfirmInstapay(e, r.id)).toEqual({ state: 'needs_human', reasons: ['KILL_STORE'] });
    expect(aiCalls(e)).toBe(0);
  });

  it('first payment above one month of the plan, and a workspace with no plan, wait for a person; after a clean payment the cap is gone', async () => {
    const ws = W(5);
    await seedSub(ws); // gold, 500 EGP a month
    await setMode('live');
    const big = await request(ws, 'topup', { amountMinor: 60_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(60_000)), big.id)).toEqual({ state: 'needs_human', reasons: ['FIRST_PAYMENT_OVER_CAP'] });
    const yearly = await request(W(6), 'package', { packageId: 'gold-yearly' });
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(500_000)), yearly.id)).reasons).toContain('FIRST_PAYMENT_OVER_CAP'); // (it is also over the two-approver threshold)
    const noPlan = await request(W(7), 'topup', { amountMinor: 20_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), noPlan.id)).toEqual({ state: 'needs_human', reasons: ['FIRST_PAYMENT_OVER_CAP'] });
    // A person-confirmed earlier payment is clean at once: now the same large top-up goes through.
    const earlier = await request(ws, 'topup', { amountMinor: 10_000 });
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = 'op-human', decided_at = ? WHERE id = ?").bind(Date.now(), earlier.id).run();
    const big2 = await request(ws, 'topup', { amountMinor: 60_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(60_000)), big2.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
  });

  it('INSTAPAY-CLEAN-1: an auto-confirmed payment is NOT clean until a digest was SENT, so the next large payment still waits; after the stamp it does not', async () => {
    const ws = W(8);
    await seedSub(ws);
    await setMode('live');
    const a = await request(ws, 'topup', { amountMinor: 20_000 });
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), a.id)).state).toBe('auto_confirmed');
    const b = await request(ws, 'topup', { amountMinor: 60_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(60_000)), b.id)).toEqual({ state: 'needs_human', reasons: ['FIRST_PAYMENT_OVER_CAP'] });
    await env.DB.prepare('UPDATE instapay_auto_confirmations SET digest_sent_at = ? WHERE request_id = ?').bind(Date.now(), a.id).run();
    const c = await request(ws, 'topup', { amountMinor: 60_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(60_000)), c.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
  });

  it('an amount at or above the two-approver threshold always waits; a held (duplicate image) request is not attempted', async () => {
    const ws = W(9);
    await seedSub(ws);
    await setMode('live');
    const low = { ...env, ADJUSTMENT_APPROVAL_MINOR: '20000' } as typeof env;
    const r = await request(ws, 'topup', { amountMinor: 20_000 });
    const e = aiEnv(goodAnswer(20_000), low);
    expect(await autoConfirmInstapay(e, r.id)).toEqual({ state: 'needs_human', reasons: ['ABOVE_DUAL_CONTROL_THRESHOLD'] });
    const held = await request(ws, 'topup', { amountMinor: 20_000 });
    await env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_image' WHERE id = ?").bind(held.id).run();
    const e2 = aiEnv(goodAnswer(20_000));
    expect(await autoConfirmInstapay(e2, held.id)).toEqual({ state: 'needs_human', reasons: ['DUPLICATE_IMAGE'] });
    expect(aiCalls(e2)).toBe(0);
  });

  it('an upgrade/queued renewal (changes a running plan) waits for a person', async () => {
    const ws = W(10);
    await seedSub(ws, 'gold');
    const r = await request(ws, 'package');
    await setMode('live');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000)), r.id)).toMatchObject({ state: 'needs_human', reasons: expect.arrayContaining(['ABOVE_DUAL_CONTROL_THRESHOLD']) });
  });

  it('a tampered order (amount differs from its request) is refused BEFORE anything is confirmed: P1 alert, the dedupe claim this call made is released', async () => {
    const ws = W(11);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    const spy = vi.spyOn(console, 'error');
    await env.DB.prepare('UPDATE topups SET amount_minor = amount_minor + 1 WHERE order_id = ?').bind(r.id).run();
    const out = await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id);
    expect(out).toEqual({ state: 'needs_human', reasons: ['AMOUNT_MISMATCH'] });
    expect((await reqRow(r.id))!.state).toBe('under_review');
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('instapay_amount_mismatch'))).toBe(true);
    expect(await env.INSTAPAY_DEDUPE_DB!.prepare('SELECT count(*) AS n FROM instapay_dedupe').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('activation failure after the confirm (the grant throws): the row is failed, the request stays confirmed for the daily repair, P1 alert, the claim stays held', async () => {
    const ws = W(15);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    const spy = vi.spyOn(console, 'error');
    const e = aiEnv(goodAnswer(20_000));
    // The wallet credit is refused after the request was confirmed: break the workspace DO call.
    const real = e.WORKSPACE_DO;
    const broken = { ...e, WORKSPACE_DO: { idFromName: real.idFromName.bind(real), get: () => ({ postWallet: async () => { throw new Error('do down'); } }) } } as unknown as typeof env;
    const out = await autoConfirmInstapay(broken, r.id);
    expect(out).toEqual({ state: 'failed', reasons: [] });
    expect((await reqRow(r.id))!.state).toBe('confirmed');
    expect((await reqRow(r.id))!.granted_at).toBeNull();
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('instapay_grant_failed'))).toBe(true);
    // the daily repair finishes the grant exactly once
    const { repairInstapay } = await import('../src/core/billing/instapay');
    await repairInstapay(env);
    expect(await walletBalance(ws)).toBe(20_000);
    await repairInstapay(env);
    expect(await walletBalance(ws)).toBe(20_000);
  });

  it('no dedupe binding, or a model failure: needs a person (fail closed)', async () => {
    const ws = W(12);
    await seedSub(ws);
    await setMode('live');
    const a = await request(ws, 'topup');
    expect((await autoConfirmInstapay(aiEnv('throw'), a.id)).reasons).toEqual(expect.arrayContaining(['EXTRACT_INCOMPLETE', 'LOW_CONFIDENCE']));
    const b = await request(ws, 'topup');
    const noIndex = { ...aiEnv(goodAnswer(20_000)), INSTAPAY_DEDUPE_DB: undefined } as unknown as typeof env;
    expect(await autoConfirmInstapay(noIndex, b.id)).toEqual({ state: 'needs_human', reasons: ['KILL_GLOBAL'] }); // not ready = off
    expect((await reqRow(b.id))!.state).toBe('under_review');
  });

  it('a request a person already decided is skipped, never re-decided', async () => {
    const ws = W(13);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await env.DB.prepare("UPDATE instapay_requests SET state = 'rejected' WHERE id = ?").bind(r.id).run();
    await setMode('live');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id)).toEqual({ state: 'needs_human', reasons: [] });
    expect(await autoRow(r.id)).toMatchObject({ verdict: 'skipped:not_reviewable' });
  });

  it('an abandoned pending decision is taken over after the lease and finished once', async () => {
    const ws = W(14);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    await env.DB.prepare("INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, idempotency_key, created_at, updated_at) VALUES ('stuck-1', ?, ?, 'pending_decision', ?, 0, 0)").bind(r.id, ws, `instapay-auto:chat:${r.id}`).run();
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id, 10_000)).toEqual({ state: 'pending_decision', reasons: [] }); // lease not over: leave it
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id, Date.now())).toEqual({ state: 'auto_confirmed', reasons: [] });
    expect(await walletBalance(ws)).toBe(20_000);
  });
});
void HOUR;
