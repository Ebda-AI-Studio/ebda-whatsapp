import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1DuplicateIndex, type D1Like } from '../foundation/instapay-dedupe';
import * as auto from '../src/core/billing/instapay-auto';
import { CONFIRM_CLAIM_SQL, confirmInstapay, rejectInstapay } from '../src/core/billing/instapay';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiEnv, autoRow, goodAnswer, nextRef, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

// Opus money review of PR 87 @ dbeaa3a: one test per finding, each failing on that head.
useApiKey();
useStoreLink();
const W = (n: number) => W0(9300 + n);
const store = () => new D1DuplicateIndex(env.INSTAPAY_DEDUPE_DB as unknown as D1Like);
const held = async () => (await env.INSTAPAY_DEDUPE_DB!.prepare("SELECT count(*) AS n FROM instapay_dedupe WHERE state = 'held'").first<{ n: number }>())!.n;
const wallet = async (ws: string) => (await rows<{ b: number }>(ws, 'SELECT coalesce((SELECT balance_after FROM wallet_ledger ORDER BY id DESC LIMIT 1), 0) AS b'))[0]!.b;
const sha = async (id: string) => (await env.DB.prepare('SELECT proof_sha256 AS s FROM instapay_requests WHERE id = ?').bind(id).first<{ s: string }>())!.s;
const OP = { actor: 'telegram-owner', reason: 'not received (owner tap)' };
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

describe('I1: a person\'s confirmation claims the shared index; history is burned by the backfill', () => {
  it('after a person confirms with a numeric bank reference, the Store can no longer claim that receipt', async () => {
    const ws = W(1);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    const ref = nextRef();
    expect((await confirmInstapay(env, { id: r.id, actor: 'op-human', bankRef: ref })).ok).toBe(true);
    expect(await store().claim({ referenceKey: ref, imageSha256: 'c'.repeat(64), product: 'store', ownerId: 'store-1', paymentId: 'receipt-1' })).toBe('duplicate_reference');
    expect(await store().claim({ referenceKey: '123123123123', imageSha256: await sha(r.id), product: 'store', ownerId: 'store-1', paymentId: 'receipt-2' })).toBe('duplicate_image');
  });
  it('a receipt the Store already holds is HELD on a person\'s confirm, never confirmed', async () => {
    const ws = W(2);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    const ref = nextRef();
    await store().claim({ referenceKey: ref, imageSha256: 'd'.repeat(64), product: 'store', ownerId: 'store-2', paymentId: 'receipt-3' });
    expect(await confirmInstapay(env, { id: r.id, actor: 'op-human', bankRef: ref })).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await reqRow(r.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_reference' });
  });
  it('the backfill burns every confirmed numeric reference + image, is re-runnable, and skips references with letters', async () => {
    const ws = W(3);
    await seedSub(ws);
    const a = await request(ws, 'topup');
    const b = await request(ws, 'topup');
    const ref = nextRef();
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = 'op-old', decided_at = 5, bank_ref = ? WHERE id = ?").bind(ref, a.id).run(); // confirmed before the index existed
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = 'op-old', decided_at = 6, bank_ref = 'BK900777' WHERE id = ?").bind(b.id).run();
    const first = await auto.backfillDedupeHistory(env, { actor: 'op-1', reason: 'burn history before live' });
    expect(first).toMatchObject({ ok: true });
    expect((first as { burned: number }).burned).toBeGreaterThanOrEqual(1);
    expect((first as { skipped: number }).skipped).toBeGreaterThanOrEqual(1);
    expect(await store().claim({ referenceKey: ref, imageSha256: 'e'.repeat(64), product: 'store', ownerId: 'store-3', paymentId: 'receipt-4' })).toBe('duplicate_reference');
    expect(await auto.backfillDedupeHistory(env, { actor: 'op-1', reason: 'burn history before live' })).toEqual(first);
    expect(await auto.backfillDedupeHistory(env, { actor: 'op-1', reason: 'x' })).toEqual({ ok: false, reason: 'reason_required' });
  });
});

describe('I2 + M7: claims are kept while the payment can still be confirmed, released only when it is rejected', () => {
  const racing = (e: typeof env, to: 'confirmed' | 'rejected', id: string) => {
    const real = e.DB;
    const db = {
      prepare: (sql: string) => {
        const st = real.prepare(sql);
        if (sql !== CONFIRM_CLAIM_SQL) return st;
        return { bind: (...v: unknown[]) => ({ run: async () => { await real.prepare(`UPDATE instapay_requests SET state = ?, decided_by = 'op-human' WHERE id = ?`).bind(to, id).run(); return st.bind(...v).run(); } }) };
      },
      batch: real.batch.bind(real), exec: real.exec.bind(real),
    };
    return { ...e, DB: db } as unknown as typeof env;
  };
  it('a person confirms between the decision and the system\'s confirm: the system waits and the claim STAYS (it guards that confirmation)', async () => {
    const ws = W(4);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    const out = await auto.autoConfirmInstapay(racing(aiEnv(goodAnswer(20_000)), 'confirmed', r.id), r.id);
    expect(out).toEqual({ state: 'needs_human', reasons: ['DUPLICATE_REFERENCE'] });
    expect(await held()).toBe(2);
  });
  it('a person rejects it in the race: the claim is released', async () => {
    const ws = W(5);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    await auto.autoConfirmInstapay(racing(aiEnv(goodAnswer(20_000)), 'rejected', r.id), r.id);
    expect(await held()).toBe(0);
  });
  it('M7: rejecting a request that waits for a person releases its claim (the receipt can be used for a correct request)', async () => {
    const ws = W(6);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    await auto.autoConfirmInstapay(aiEnv({ ...goodAnswer(20_000), amount: '199.99' }), r.id);
    expect(await held()).toBe(2);
    expect((await rejectInstapay(env, { id: r.id, actor: 'op-human', reason: 'wrong amount' })).ok).toBe(true);
    expect(await held()).toBe(0);
  });
});

describe('I4: a package is due at the ORDER amount', () => {
  it('the price moved after the order: a receipt for the NEW price waits (AMOUNT_MISMATCH), it is never confirmed against the old order', async () => {
    const ws = W(7);
    const r = await request(ws, 'package'); // ordered at 500 EGP
    await env.DB.prepare("UPDATE packages SET price_minor = 60000 WHERE id = 'gold'").run();
    try {
      await setMode('live');
      const out = await auto.autoConfirmInstapay(aiEnv(goodAnswer(60_000)), r.id);
      expect(out.state).toBe('needs_human');
      expect(out.reasons).toContain('AMOUNT_MISMATCH');
      expect((await reqRow(r.id))!.state).toBe('under_review');
      const r2 = await request(W(8), 'package', { amountMinor: 60_000 }); // priced at 600 now
      await env.DB.prepare("UPDATE packages SET price_minor = 50000 WHERE id = 'gold'").run();
      expect((await auto.autoConfirmInstapay(aiEnv(goodAnswer(60_000)), r2.id)).reasons).toContain('AMOUNT_MISMATCH'); // receipt = order, but the price moved: a person looks
    } finally {
      await env.DB.prepare("UPDATE packages SET price_minor = 50000 WHERE id = 'gold'").run();
    }
  });
});

describe('I5 (INSTAPAY-CAP-1): the first-payment cap is cumulative until a digest was sent', () => {
  it('three 200 EGP top-ups under a 500 EGP plan month: two confirm, the third waits', async () => {
    const ws = W(9);
    await seedSub(ws);
    const reqs = [await request(ws, 'topup'), await request(ws, 'topup'), await request(ws, 'topup')];
    await setMode('live');
    const outs = [];
    for (const r of reqs) outs.push(await auto.autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id));
    expect(outs.map((o) => o.state)).toEqual(['auto_confirmed', 'auto_confirmed', 'needs_human']);
    expect(outs[2]!.reasons).toEqual(['FIRST_PAYMENT_OVER_CAP']);
  });
});

describe('I6 (INSTAPAY-REVERT-1): a top-up revert never takes money that arrived later', () => {
  it('200 auto top-up, 150 spent, then a 500 card top-up: the revert removes 50, the card money stays', async () => {
    const ws = W(10);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    expect((await auto.autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id)).state).toBe('auto_confirmed');
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -15_000, ref: 'spend-i6', actor: 'test', note: 'spent' });
    await workspace(ws).postWallet({ kind: 'topup', netMinor: 50_000, ref: 'kashier:card-later' });
    expect(await wallet(ws)).toBe(55_000);
    expect(await auto.revertAutoConfirmed(env, { id: r.id, ...OP })).toMatchObject({ ok: true, creditsRemovedMinor: 5_000, creditsUsedMinor: 15_000 });
    expect(await wallet(ws)).toBe(50_000);
  });
});

describe('M9: a revert finished by a second call writes its audit rows and the workspace switch once', () => {
  it('re-running the finishing steps does not duplicate the audit rows or re-toggle the switch', async () => {
    const ws = W(11);
    await seedSub(ws);
    const r = await request(ws, 'topup');
    await setMode('live');
    await auto.autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id);
    await auto.revertAutoConfirmed(env, { id: r.id, ...OP });
    await env.DB.prepare('UPDATE instapay_auto_confirmations SET credits_removed_minor = NULL WHERE request_id = ?').bind(r.id).run(); // as if the first call died before its marker
    await auto.revertAutoConfirmed(env, { id: r.id, ...OP });
    const n = async (action: string) => (await env.DB.prepare('SELECT count(*) AS n FROM billing_audit WHERE action = ? AND workspace_id = ?').bind(action, ws).first<{ n: number }>())!.n;
    expect(await n('instapay_auto_reverted')).toBe(1);
    expect(await n('instapay_auto_reverted_credits')).toBe(1);
    expect(await n('instapay_auto_workspace_toggled')).toBe(1);
    expect((await autoRow(r.id))!.credits_removed_minor).toBe(20_000);
  });
});
