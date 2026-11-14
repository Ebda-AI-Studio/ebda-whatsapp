import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoConfirmInstapay, sweepAutoConfirm } from '../src/core/billing/instapay-auto';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiCalls, aiEnv, autoRow, goodAnswer, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9950 + n);
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

describe('C4: trigger and sweep', () => {
  it('a proof upload triggers exactly one auto attempt (live): the request is confirmed when the upload returns; mode off: not even a row', async () => {
    const ws = W(1);
    await seedSub(ws);
    const off = await request(ws, 'topup', { e: aiEnv(goodAnswer(20_000)) });
    expect(await autoRow(off.id)).toBeNull();
    expect((await reqRow(off.id))!.state).toBe('under_review');
    await setMode('live');
    const e = aiEnv(goodAnswer(20_000));
    const r = await request(ws, 'topup', { e });
    expect(aiCalls(e)).toBe(1);
    expect(await autoRow(r.id)).toMatchObject({ state: 'auto_confirmed' });
    expect((await reqRow(r.id))!.state).toBe('confirmed');
  });

  it('an unexpected failure in the attempt leaves the request under review with a needs_human row (never an orphan), the upload still succeeds', async () => {
    const ws = W(2);
    await seedSub(ws);
    await setMode('live');
    const good = aiEnv(goodAnswer(20_000));
    const broken = { ...good, MEDIA: { get: async () => { throw new Error('r2 down'); }, put: good.MEDIA.put.bind(good.MEDIA), delete: good.MEDIA.delete.bind(good.MEDIA) } } as unknown as typeof env;
    const r = await request(ws, 'topup', { e: broken });
    expect((await reqRow(r.id))!.state).toBe('under_review');
    expect(await autoRow(r.id)).toMatchObject({ state: 'needs_human', reasons_json: '["EXTRACT_INCOMPLETE"]' });
  });

  it('the sweep decides only a stale proof that no trigger decided; a fresh or already-decided one is left alone; a second run is a no-op', async () => {
    const ws = W(3);
    await seedSub(ws);
    const stale = await request(ws, 'topup');
    const fresh = await request(ws, 'topup');
    const decided = await request(ws, 'topup');
    await setMode('live');
    await autoConfirmInstapay(aiEnv('throw'), decided.id); // a decision row exists
    const now = Date.now();
    await env.DB.prepare('UPDATE instapay_requests SET proof_at = ? WHERE id IN (?, ?)').bind(now - 11 * 60_000, stale.id, decided.id).run();
    const e = aiEnv((n) => goodAnswer(20_000, { reference: `55000000000${n}` }));
    expect(await sweepAutoConfirm(e, now)).toEqual({ decided: 1, completed: 0 });
    expect((await reqRow(stale.id))!.state).toBe('confirmed');
    expect(await autoRow(fresh.id)).toBeNull();
    expect((await autoRow(decided.id))!.state).toBe('needs_human');
    expect(await sweepAutoConfirm(e, now)).toEqual({ decided: 0, completed: 0 });
    expect(aiCalls(e)).toBe(1);
    // off: the sweep does nothing at all
    await setMode('off');
    expect(await sweepAutoConfirm(e, now + 3_600_000)).toEqual({ decided: 0, completed: 0 });
  });
});
