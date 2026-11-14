import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVERT_GRACE_MS } from '../foundation/instapay-state';
import { autoConfirmInstapay, revertAutoConfirmed, revertNotice, workspaceAutoEnabled } from '../src/core/billing/instapay-auto';
import { confirmInstapay } from '../src/core/billing/instapay';
import { serviceAllowed } from '../src/core/billing/entitlements';
import { postCredit } from '../src/core/ai/credits';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiEnv, autoRow, goodAnswer, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9800 + n);
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const wallet = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM wallet_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;
const aiBal = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM credit_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;
const nWallet = async (ws: string, ref: string) => (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM wallet_ledger WHERE ref LIKE ?', ref))[0]!.n;
const nAi = async (ws: string, ref: string) => (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM credit_ledger WHERE ref LIKE ?', ref))[0]!.n;
const topup = async (ws: string, amount = 20_000) => {
  await seedSub(ws);
  const r = await request(ws, 'topup', { amountMinor: amount });
  await setMode('live');
  expect((await autoConfirmInstapay(aiEnv(goodAnswer(amount)), r.id)).state).toBe('auto_confirmed');
  return r;
};
const spendWallet = (ws: string, minor: number, ref: string) => workspace(ws).postWallet({ kind: 'adjustment', netMinor: -minor, ref, actor: 'test', note: 'simulated spend' });
const spendAi = (ws: string, credits: number, ref: string) => runInDurableObject(workspace(ws), (_i, state) => { postCredit(state.storage.sql, { kind: 'ai_charge', amount: -credits, ref, now: Date.now() }); });
const OP = { actor: 'telegram-owner', reason: 'not received (owner tap)' };

describe('C5: revert of a top-up', () => {
  it('unspent: exactly the credited amount is removed, ledger entry once, audit row with the amounts, request marked, workspace auto-disabled, reference + image burned', async () => {
    const ws = W(1);
    const r = await topup(ws, 20_000);
    expect(await wallet(ws)).toBe(20_000);
    const t = Date.now();
    const out = await revertAutoConfirmed(env, { id: r.id, ...OP }, t);
    expect(out).toEqual({ ok: true, result: 'reverted', graceUntil: t + REVERT_GRACE_MS, creditsRemovedMinor: 20_000, creditsUsedMinor: 0, aiCreditsRemoved: 0, aiCreditsUsed: 0 });
    expect(await wallet(ws)).toBe(0);
    expect(await autoRow(r.id)).toMatchObject({ state: 'reverted', reverted_by: 'telegram-owner', credits_removed_minor: 20_000 });
    expect((await reqRow(r.id))!.reverted_at).toBe(t);
    expect(await workspaceAutoEnabled(env, ws)).toBe(false);
    const audit = await env.DB.prepare("SELECT after_json FROM billing_audit WHERE action = 'instapay_auto_reverted_credits' AND workspace_id = ?").bind(ws).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ creditsRemovedMinor: 20_000, creditsUsedMinor: 0 });
    // burned: the same receipt can never auto-confirm again
    const row = await env.DB.prepare('SELECT bank_ref, proof_sha256 FROM instapay_requests WHERE id = ?').bind(r.id).first<{ bank_ref: string; proof_sha256: string }>();
    expect(await env.INSTAPAY_DEDUPE_DB!.prepare("SELECT count(*) AS n FROM instapay_dedupe WHERE state = 'burned'").first()).toEqual({ n: 2 });
    expect(row!.bank_ref).toMatch(/^\d{12}$/);
  });

  it('60% already spent: only the 40% remainder is removed, the used part is recorded, the balance never goes negative', async () => {
    const ws = W(2);
    const r = await topup(ws, 20_000);
    await spendWallet(ws, 12_000, 'spend-1');
    const out = await revertAutoConfirmed(env, { id: r.id, ...OP });
    expect(out).toMatchObject({ ok: true, creditsRemovedMinor: 8_000, creditsUsedMinor: 12_000 });
    expect(await wallet(ws)).toBe(0);
  });

  it('fully spent: nothing removed (never negative), the revert still completes; credits of an EARLIER payment are untouched', async () => {
    const ws = W(3);
    const r = await topup(ws, 20_000);
    await spendWallet(ws, 20_000, 'spend-all');
    expect(await revertAutoConfirmed(env, { id: r.id, ...OP })).toMatchObject({ ok: true, creditsRemovedMinor: 0, creditsUsedMinor: 20_000 });
    expect(await wallet(ws)).toBe(0);
    const ws2 = W(4);
    await workspace(ws2).postWallet({ kind: 'topup', netMinor: 50_000, ref: 'earlier-card-topup' });
    const r2 = await topup(ws2, 20_000);
    expect(await wallet(ws2)).toBe(70_000);
    await revertAutoConfirmed(env, { id: r2.id, ...OP });
    expect(await wallet(ws2)).toBe(50_000); // the earlier 500 EGP stays
  });

  it('double tap and a replayed request: ONE ledger entry, the same amounts, already_reverted', async () => {
    const ws = W(5);
    const r = await topup(ws, 20_000);
    const first = await revertAutoConfirmed(env, { id: r.id, ...OP });
    const again = await revertAutoConfirmed(env, { id: r.id, ...OP });
    expect(first).toMatchObject({ ok: true, result: 'reverted' });
    expect(again).toEqual({ ...(first as object), result: 'already_reverted' });
    expect(await nWallet(ws, 'instapay-revert:%')).toBe(1);
    // 20 concurrent taps: still one entry
    const ws2 = W(6);
    const r2 = await topup(ws2, 20_000);
    const all = await Promise.all(Array.from({ length: 20 }, () => revertAutoConfirmed(env, { id: r2.id, ...OP })));
    expect(all.every((x) => x.ok)).toBe(true);
    expect(all.filter((x) => x.ok && x.result === 'reverted').length).toBe(1);
    expect(await nWallet(ws2, 'instapay-revert:%')).toBe(1);
    expect(await wallet(ws2)).toBe(0);
  });

  it('a revert that died half way is finished by the next call (state flipped, amounts not written)', async () => {
    const ws = W(7);
    const r = await topup(ws, 20_000);
    await env.DB.prepare("UPDATE instapay_auto_confirmations SET state = 'reverted', reverted_at = ?, reverted_by = 'x', grace_until = ? WHERE request_id = ?").bind(Date.now(), Date.now() + REVERT_GRACE_MS, r.id).run();
    expect(await revertAutoConfirmed(env, { id: r.id, ...OP })).toMatchObject({ ok: true, result: 'already_reverted', creditsRemovedMinor: 20_000 });
    expect(await wallet(ws)).toBe(0);
  });

  it('a person-confirmed payment, a pending request and an unknown id are refused; a reason is required', async () => {
    const ws = W(8);
    await seedSub(ws);
    const h = await request(ws, 'topup');
    await confirmInstapay(env, { id: h.id, actor: 'op-human', bankRef: 'HUMAN123456' });
    expect(await revertAutoConfirmed(env, { id: h.id, ...OP })).toEqual({ ok: false, reason: 'not_found' }); // no auto row at all: not an auto payment
    await setMode('live');
    const n = await request(ws, 'topup');
    await autoConfirmInstapay(aiEnv('throw'), n.id); // needs_human
    expect(await revertAutoConfirmed(env, { id: n.id, ...OP })).toEqual({ ok: false, reason: 'not_auto_confirmed' });
    expect(await revertAutoConfirmed(env, { id: 'nope', ...OP })).toEqual({ ok: false, reason: 'not_found' });
    const a = await topup(W(9), 20_000);
    expect(await revertAutoConfirmed(env, { id: a.id, actor: 'x', reason: 'no' })).toEqual({ ok: false, reason: 'reason_required' });
    expect((await reqRow(a.id))!.state).toBe('confirmed');
  });
});

describe('C5: revert of a package payment', () => {
  const pkg = async (ws: string, o: { consume?: number } = {}) => {
    const r = await request(ws, 'package');
    await setMode('live');
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(50_000)), r.id)).state).toBe('auto_confirmed');
    if (o.consume) await spendAi(ws, o.consume, `charge-${ws}`);
    return r;
  };

  it('all AI credits unused: exactly the granted amount is reversed by ONE ledger entry; the plan gets the 48 h grace (in effect at +47h59m, ended at +48h)', async () => {
    const ws = W(11);
    const r = await pkg(ws);
    expect(await aiBal(ws)).toBe(300);
    const t = Date.now();
    const out = await revertAutoConfirmed(env, { id: r.id, ...OP }, t);
    expect(out).toMatchObject({ ok: true, result: 'reverted', graceUntil: t + REVERT_GRACE_MS, aiCreditsRemoved: 300, aiCreditsUsed: 0 });
    expect(await aiBal(ws)).toBe(0);
    expect(await nAi(ws, 'instapay-revert:%')).toBe(1);
    const sub = await env.DB.prepare('SELECT period_end, payment_unconfirmed_until, status FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ period_end: number; payment_unconfirmed_until: number; status: string }>();
    expect(sub).toMatchObject({ period_end: t + REVERT_GRACE_MS, payment_unconfirmed_until: t + REVERT_GRACE_MS, status: 'active' });
    const allowed = (at: number) => runInDurableObject(workspace(ws), (_i, state) => serviceAllowed(state.storage.sql, at));
    expect(await allowed(t + REVERT_GRACE_MS - 60_000)).toBe(true);
    expect(await allowed(t + REVERT_GRACE_MS)).toBe(false);
    expect(await revertNotice(env, ws, t + 1000)).toMatchObject({ requestId: r.id, kind: 'package', graceUntil: t + REVERT_GRACE_MS });
    expect(await revertNotice(env, ws, t + REVERT_GRACE_MS + 1)).toBeNull();
  });

  it('70% of the AI credits consumed: only the 30% remainder is reversed, the used part recorded, never negative; fully consumed: nothing reversed, plan still graced', async () => {
    const ws = W(12);
    const r = await pkg(ws, { consume: 210 });
    expect(await revertAutoConfirmed(env, { id: r.id, ...OP })).toMatchObject({ ok: true, aiCreditsRemoved: 90, aiCreditsUsed: 210 });
    expect(await aiBal(ws)).toBe(0);
    const ws2 = W(13);
    const r2 = await pkg(ws2, { consume: 300 });
    expect(await revertAutoConfirmed(env, { id: r2.id, ...OP })).toMatchObject({ ok: true, aiCreditsRemoved: 0, aiCreditsUsed: 300 });
    expect(await nAi(ws2, 'instapay-revert:%')).toBe(0);
    expect((await env.DB.prepare('SELECT payment_unconfirmed_until AS p FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws2).first<{ p: number }>())!.p).toBeGreaterThan(0);
  });

  it('double tap: one ledger entry, the same amounts; a new confirmed payment inside the grace clears the marker', async () => {
    const ws = W(14);
    const r = await pkg(ws);
    const a = await revertAutoConfirmed(env, { id: r.id, ...OP });
    expect(await revertAutoConfirmed(env, { id: r.id, ...OP })).toEqual({ ...(a as object), result: 'already_reverted' });
    expect(await nAi(ws, 'instapay-revert:%')).toBe(1);
    // the merchant uploads a correct receipt: a person confirms it (the normal path) and the grace marker is cleared
    const fix = await request(ws, 'package');
    expect((await confirmInstapay(env, { id: fix.id, actor: 'op-human', bankRef: 'GOODREF9999' })).ok).toBe(true);
    expect((await env.DB.prepare('SELECT payment_unconfirmed_until AS p FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ p: number | null }>())!.p).toBeNull();
  });

  it('after the revert the same receipt cannot auto-confirm again (burned), and the workspace is back to manual review', async () => {
    const ws = W(15);
    const r = await pkg(ws);
    const bank = (await env.DB.prepare('SELECT bank_ref FROM instapay_requests WHERE id = ?').bind(r.id).first<{ bank_ref: string }>())!.bank_ref;
    await revertAutoConfirmed(env, { id: r.id, ...OP });
    await setMode('live');
    const again = await request(ws, 'package');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000, { reference: bank })), again.id)).toMatchObject({ state: 'needs_human', reasons: expect.arrayContaining(['KILL_STORE']) });
    // another workspace, same reference: duplicate
    const ws2 = W(16);
    const other = await request(ws2, 'package');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000, { reference: bank })), other.id)).toMatchObject({ state: 'needs_human', reasons: expect.arrayContaining(['DUPLICATE_REFERENCE']) });
  });

  it('a repair pass can never grant a reverted payment', async () => {
    const ws = W(17);
    const r = await pkg(ws);
    await revertAutoConfirmed(env, { id: r.id, ...OP });
    await env.DB.prepare('UPDATE instapay_requests SET granted_at = NULL WHERE id = ?').bind(r.id).run();
    const { repairInstapay } = await import('../src/core/billing/instapay');
    await repairInstapay(env);
    expect((await reqRow(r.id))!.granted_at).toBeNull();
  });
});
