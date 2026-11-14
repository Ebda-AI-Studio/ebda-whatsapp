import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBridge } from '../foundation/instapay-digest';
import { autoConfirmInstapay, revertAutoConfirmed } from '../src/core/billing/instapay-auto';
import { runInstapayDigest, notifyBrain, STALE_DIGEST_MS } from '../src/core/billing/instapay-notify';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiEnv, autoRow, goodAnswer, request, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9970 + n);
const SECRET = 'test-bridge-secret-0123456789';
beforeEach(async () => {
  await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run();
  await env.DB.prepare("UPDATE instapay_auto_confirmations SET digest_sent_at = 1 WHERE digest_sent_at IS NULL AND state = 'auto_confirmed'").run(); // earlier tests' payments are out of the way
  sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('off');
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

type Call = { url: string; headers: Record<string, string>; body: string };
function brain(answer: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
    return answer(calls.length);
  });
  return calls;
}
const sent = () => new Response(JSON.stringify({ sent: true }), { status: 200 });
const autoPayment = async (ws: string, amount = 20_000) => {
  await seedSub(ws);
  const r = await request(ws, 'topup', { amountMinor: amount });
  await setMode('live');
  expect((await autoConfirmInstapay(aiEnv(goodAnswer(amount)), r.id)).state).toBe('auto_confirmed');
  return r;
};

describe('C7: digest and waiting notices', () => {
  it('stamps digest_sent_at ONLY when the brain answers 2xx with sent:true; a 5xx, a non-sent 200 and a network error leave the rows for the next run', async () => {
    const ws = W(1);
    const a = await autoPayment(ws);
    const b = await autoPayment(W(2));
    for (const bad of [() => new Response('boom', { status: 502 }), () => new Response(JSON.stringify({ sent: false, empty: true }), { status: 200 }), () => { throw new Error('network'); }]) {
      brain(bad as never);
      expect((await runInstapayDigest(env)).sent).toBe(0);
      expect((await autoRow(a.id))!.digest_sent_at).toBeNull();
    }
    const calls = brain(sent);
    expect(await runInstapayDigest(env)).toEqual({ sent: 2, pending: 0 });
    expect(calls.length).toBe(1);
    const payload = JSON.parse(calls[0]!.body) as { kind: string; items: Array<{ product: string; id: string; amountMinor: number }> };
    expect(payload.kind).toBe('digest');
    expect(payload.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(payload.items.every((i) => i.product === 'chat' && i.amountMinor === 20_000)).toBe(true);
    // signed as `notify` with the product header, verified exactly as the brain does
    expect(calls[0]!.headers['x-bridge-product']).toBe('chat');
    expect(await verifyBridge(SECRET, calls[0]!.body, Number(calls[0]!.headers['x-bridge-ts']), calls[0]!.headers['x-bridge-sig']!, Date.now(), 'notify')).toBe(true);
    expect(await verifyBridge(SECRET, calls[0]!.body, Number(calls[0]!.headers['x-bridge-ts']), calls[0]!.headers['x-bridge-sig']!, Date.now(), 'revert')).toBe(false);
    expect((await autoRow(a.id))!.digest_sent_at).not.toBeNull();
  });

  it('an empty digest sends nothing; a payment reverted before the digest is not listed; the second run lists nothing again', async () => {
    const calls = brain(sent);
    expect(await runInstapayDigest(env)).toEqual({ sent: 0, pending: 0 });
    expect(calls.length).toBe(0);
    const r = await autoPayment(W(3));
    await revertAutoConfirmed(env, { id: r.id, actor: 'telegram-owner', reason: 'not received (owner tap)' });
    expect(await runInstapayDigest(env)).toEqual({ sent: 0, pending: 0 });
    expect(calls.length).toBe(0);
    await autoPayment(W(4));
    expect((await runInstapayDigest(env)).sent).toBe(1);
    expect((await runInstapayDigest(env)).sent).toBe(0);
    expect(calls.length).toBe(1);
  });

  it('a digest older than 26 h that could not be delivered raises the P1 alert; more than 200 rows go out 200 a day, none dropped', async () => {
    const r = await autoPayment(W(5));
    const spy = vi.spyOn(console, 'error');
    await env.DB.prepare('UPDATE instapay_auto_confirmations SET confirmed_at = ? WHERE request_id = ?').bind(Date.now() - STALE_DIGEST_MS - 60_000, r.id).run();
    brain(() => new Response('down', { status: 503 }));
    await runInstapayDigest(env);
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('instapay_auto_digest_stale'))).toBe(true);
    // 250 rows
    await env.DB.prepare("UPDATE instapay_auto_confirmations SET digest_sent_at = 1 WHERE digest_sent_at IS NULL").run();
    const base = await autoPayment(W(6));
    const src = await env.DB.prepare('SELECT * FROM instapay_auto_confirmations WHERE request_id = ?').bind(base.id).first<Record<string, unknown>>();
    // request_id is UNIQUE, so every bulk row gets its own (confirmed) request first
    await env.DB.batch(Array.from({ length: 249 }, (_, i) => env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, currency, state, created_by, created_at, expires_at) VALUES (?, ?, ?, 'topup', 1000, 'EGP', 'confirmed', 'u', 1, 2)").bind(`bulkreq-${i}`, `WA-BULK${i}`, src!.workspace_id)));
    await env.DB.batch(Array.from({ length: 249 }, (_, i) => env.DB.prepare("INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, verdict, idempotency_key, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, 'auto_confirmed', 'auto_confirm', ?, ?, 1, 1)").bind(`bulk-${i}`, `bulkreq-${i}`, src!.workspace_id, `bulk-key-${i}`, 5000 + i)));
    const calls = brain(sent);
    expect(await runInstapayDigest(env)).toEqual({ sent: 200, pending: 50 });
    expect(JSON.parse(calls[0]!.body).items.length).toBe(200);
    expect(await runInstapayDigest(env)).toEqual({ sent: 50, pending: 0 }); // "the next day"
  });

  it('a needs_human outcome sends ONE waiting notice with the reasons (not in mode off); a failed send is not stamped', async () => {
    const ws = W(7);
    await seedSub(ws);
    await setMode('shadow');
    const calls = brain(sent);
    const r = await request(ws, 'topup');
    await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r.id);
    expect(calls.length).toBe(1);
    const p = JSON.parse(calls[0]!.body) as { kind: string; items: Array<{ id: string; reasons: string[] }> };
    expect(p.kind).toBe('waiting');
    expect(p.items[0]).toMatchObject({ id: r.id, reasons: ['SHADOW_MODE'] });
    expect((await autoRow(r.id))!.waiting_notified_at).not.toBeNull();
    brain(() => new Response('down', { status: 500 }));
    const r2 = await request(ws, 'topup');
    await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r2.id);
    expect((await autoRow(r2.id))!.waiting_notified_at).toBeNull();
    await setMode('off');
    const calls3 = brain(sent);
    const r3 = await request(ws, 'topup');
    await autoConfirmInstapay(aiEnv(goodAnswer(20_000)), r3.id);
    expect(calls3.length).toBe(0); // dormant: no notice
  });

  it('notifyBrain refuses without a bridge secret or an https url', async () => {
    const calls = brain(sent);
    expect(await notifyBrain({ ...env, INSTAPAY_BRIDGE_SECRET: undefined } as typeof env, 'digest', [])).toBe(false);
    expect(await notifyBrain({ ...env, BRAIN_BRIDGE_URL: 'http://brain' } as typeof env, 'digest', [])).toBe(false);
    expect(calls.length).toBe(0);
  });
});
