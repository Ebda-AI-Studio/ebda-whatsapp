import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBusinessMs, businessMsBetween } from '../src/core/billing/business-hours';
import { confirmInstapay, createInstapayRequest, expireInstapay, overdueInstapay, rejectInstapay, repairInstapay, storeProof } from '../src/core/billing/instapay';
import { repairPackageOrders } from '../src/core/billing/package-orders';
import { repairTopups } from '../src/core/billing/topups';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { dailyBilling } from '../src/index';
import { OP1, OP2, adminToken, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { ledger } from './helpers/billing';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { exec, openChat, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9600 + n);
const HOUR = 3_600_000;
const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };
beforeEach(async () => {
  configureSessionCheck(async () => false);
  configurePayments(() => testKashier());
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
// Every upload gets 4 random trailing bytes: the same image on two requests is now a held duplicate (C2), and these tests reuse a few tiny fixtures.
const bytes = (u: Uint8Array) => { if (u.byteLength === 0) return u.buffer.slice(0) as ArrayBuffer; const b = new Uint8Array(u.byteLength + 4); b.set(u); crypto.getRandomValues(b.subarray(u.byteLength)); return b.buffer as ArrayBuffer; };
const uniq = (u: Uint8Array) => new Uint8Array(bytes(u));

const pkgReq = async (ws: string, o: { userId?: string; now?: number; e?: typeof env } = {}) => {
  await seedNumber(`pn-ip-${ws.slice(-6)}`, ws);
  const r = await createInstapayRequest(o.e ?? env, { workspaceId: ws, userId: o.userId ?? 'merchant-1', sessionId: 's1', input: { kind: 'package', packageId: 'gold' }, payee: PAYEE }, o.now ?? Date.now());
  if (!r.ok) throw new Error(r.reason);
  return r.request;
};
const topupReq = async (ws: string, amountMinor = 20000, o: { userId?: string; now?: number } = {}) => {
  await seedNumber(`pn-ip-${ws.slice(-6)}`, ws);
  const r = await createInstapayRequest(env, { workspaceId: ws, userId: o.userId ?? 'merchant-1', sessionId: 's1', input: { kind: 'topup', amountMinor }, payee: PAYEE }, o.now ?? Date.now());
  if (!r.ok) throw new Error(r.reason);
  return r.request;
};
const proof = (ws: string, id: string, body: Uint8Array = PNG, now = Date.now()) => storeProof(env, { workspaceId: ws, requestId: id, sessionId: 's1', bytes: bytes(body), contentType: body === PDF ? 'application/pdf' : body === JPG ? 'image/jpeg' : body === WEBP ? 'image/webp' : 'image/png' }, now);
const row = (id: string) => env.DB.prepare('SELECT state, amount_minor, granted_at, reject_reason, first_approver, decided_by, proof_key FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; amount_minor: number; granted_at: number | null; reject_reason: string | null; first_approver: string | null; decided_by: string | null; proof_key: string | null }>();
const orderRow = (table: 'package_orders' | 'topups', id: string) => env.DB.prepare(table === 'package_orders' ? 'SELECT status AS s, provider, provider_ref AS ref FROM package_orders WHERE order_id = ?' : 'SELECT state AS s, provider, transaction_id AS ref FROM topups WHERE order_id = ?').bind(id).first<{ s: string; provider: string; ref: string | null }>();
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, version, source FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first();
const audits = async (ws: string) => (await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first<{ n: number }>())!.n;
const lowThreshold = { ...env, ADJUSTMENT_APPROVAL_MINOR: '10000' } as typeof env;

describe('creating a request: the server owns the amount', () => {
  it('WA-NOFREE-1: a workspace with NO package can still pay by InstaPay (a merchant must be able to buy), for a package and for a top-up', async () => {
    const ws = W(98);
    await seedNumber(`pn-ip-${ws.slice(-6)}`, ws);
    await exec(ws, 'DELETE FROM entitlements');
    expect(await workspace(ws).getEntitlement()).toBeNull();
    const p = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'package', packageId: 'gold' }, payee: PAYEE });
    const t = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'topup', amountMinor: 20000 }, payee: PAYEE });
    expect([p.ok, t.ok]).toEqual([true, true]);
  });

  it('a package request costs packages.price_minor, has a human-typable reference and a 48 h expiry, and shows the configured payee', async () => {
    const ws = W(1);
    const now = Date.now();
    const r = await pkgReq(ws, { now });
    expect(r).toMatchObject({ kind: 'package', packageId: 'gold', amountMinor: 50000, state: 'awaiting_proof', expiresAt: now + 48 * HOUR });
    expect(r.reference).toMatch(/^WA-[A-HJ-NP-Z2-9]{8}$/);
    expect(await orderRow('package_orders', r.id)).toEqual({ s: 'pending', provider: 'instapay', ref: null });
    const owner = await apiFor(ws);
    const list = await (await owner.call('GET', '/wallet/instapay')).json() as { enabled: boolean; payee: typeof PAYEE; items: { id: string; reference: string }[] };
    expect(list.enabled).toBe(true);
    expect(list.payee).toEqual(PAYEE);
    expect(list.items.map((i) => i.id)).toContain(r.id);
  });
  it('the amount cannot be tampered with: the body is strict, a top-up is bounded, an unknown or free package is refused', async () => {
    const owner = await apiFor(W(2));
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'package', packageId: 'gold', amountMinor: 1 })).status).toBe(400);
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 999 })).status).toBe(400);
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 5_000_001 })).status).toBe(400);
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'package', packageId: 'store-included' })).status).toBe(400);
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'package', packageId: 'nope' })).status).toBe(400);
    const ok = await owner.call('POST', '/wallet/instapay', { kind: 'package', packageId: 'gold' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ amountMinor: 50000, payee: PAYEE });
  });
  it('owner only; a revoked session is refused; staff get 403 on every merchant route', async () => {
    const ws = W(3);
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('GET', '/wallet/instapay')).status).toBe(403);
    expect((await staff.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 5000 })).status).toBe(403);
    const r = await pkgReq(ws);
    expect((await SELF.fetch(`https://x/api/v1/stores/${ws}/wallet/instapay/${r.id}/proof`, { method: 'PUT', headers: { authorization: `Bearer ${staff.token}`, 'content-type': 'image/png' }, body: uniq(PNG) })).status).toBe(403);
    configureSessionCheck(async () => true);
    const owner = await apiFor(ws);
    expect((await owner.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 5000 })).status).toBe(403); // M-135: the store middleware refuses a revoked session on every write, before the route's own money check
  });
  it('switched off or without a payee it is unavailable and writes nothing', async () => {
    const ws = W(4);
    await seedNumber('pn-ip-w4', ws);
    const off = { ...env, INSTAPAY_BILLING_ENABLED: undefined } as typeof env;
    expect(await createInstapayRequest(off, { workspaceId: ws, userId: 'u', sessionId: 's', input: { kind: 'topup', amountMinor: 5000 }, payee: PAYEE })).toEqual({ ok: false, reason: 'disabled' });
    expect(await createInstapayRequest(env, { workspaceId: ws, userId: 'u', sessionId: 's', input: { kind: 'topup', amountMinor: 5000 }, payee: null })).toEqual({ ok: false, reason: 'unavailable' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM instapay_requests WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
  it('the reference is unique in the database', async () => {
    const a = await pkgReq(W(5));
    await expect(env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, package_id, amount_minor, state, created_by, created_at, expires_at) VALUES ('dup', ?, ?, 'package', 'gold', 1, 'awaiting_proof', 'u', 1, 2)").bind(a.reference, W(5)).run()).rejects.toThrow();
  });
});

describe('the proof of transfer', () => {
  it('jpeg, png, webp and pdf are accepted by their magic bytes and stored PRIVATE under the workspace', async () => {
    for (const [i, body] of [PNG, JPG, WEBP, PDF].entries()) {
      const ws = W(10 + i);
      const r = await pkgReq(ws);
      const out = await proof(ws, r.id, body);
      expect(out).toMatchObject({ ok: true, request: { state: 'under_review' } });
      const key = (await row(r.id))!.proof_key!;
      expect(key.startsWith(`instapay-proof/${ws}/${r.id}`)).toBe(true);
      expect(await env.MEDIA.head(key)).not.toBeNull();
    }
  });
  it('the stored proof is not reachable without a signed link, and the media routes do not know it', async () => {
    const ws = W(15);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    const key = (await row(r.id))!.proof_key!;
    expect((await SELF.fetch(`https://x/api/v1/instapay-proof/${encodeURIComponent(key)}`)).status).toBe(404);
    expect((await SELF.fetch('https://x/api/v1/instapay-proof/forged.token')).status).toBe(404);
    const owner = await apiFor(ws);
    expect([400, 404]).toContain((await owner.call('GET', `/media/${encodeURIComponent(key)}`)).status);
  });
  it('a wrong type or size is refused: html, svg, a lying content-type, empty, over 5 MB', async () => {
    const ws = W(16);
    const r = await pkgReq(ws);
    const send = (body: Uint8Array, contentType: string) => storeProof(env, { workspaceId: ws, requestId: r.id, sessionId: 's1', bytes: bytes(body), contentType }, Date.now());
    expect(await send(new TextEncoder().encode('<html>'), 'text/html')).toEqual({ ok: false, reason: 'bad_type' });
    expect(await send(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toEqual({ ok: false, reason: 'bad_type' });
    expect(await send(PDF, 'image/png')).toEqual({ ok: false, reason: 'bad_type' }); // the bytes say pdf, the header says png
    expect(await send(new TextEncoder().encode('MZ-not-an-image'), 'image/png')).toEqual({ ok: false, reason: 'bad_type' });
    expect(await send(new Uint8Array(0), 'image/png')).toEqual({ ok: false, reason: 'empty' });
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(PNG);
    expect(await send(big, 'image/png')).toEqual({ ok: false, reason: 'too_large' });
    expect((await row(r.id))!.state).toBe('awaiting_proof');
    expect(await env.MEDIA.list({ prefix: `instapay-proof/${ws}/` }).then((l) => l.objects.length)).toBe(0);
  });
  it('over HTTP: a valid upload moves the request to under review, a bad one is 415, a huge one 413', async () => {
    const ws = W(17);
    const r = await pkgReq(ws);
    const owner = await apiFor(ws);
    const put = (body: BodyInit, type: string) => SELF.fetch(`https://x/api/v1/stores/${ws}/wallet/instapay/${r.id}/proof`, { method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': type }, body });
    expect((await put('hello', 'text/plain')).status).toBe(415);
    expect((await put(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png')).status).toBe(413);
    const ok = await put(uniq(PNG), 'image/png');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: 'under_review' });
    expect((await put(uniq(PNG), 'image/png')).status).toBe(409); // already submitted
  });
  it('a proof for another workspace\'s request, or after the 48 h expiry, is refused', async () => {
    const r = await pkgReq(W(18));
    expect(await proof(W(19), r.id)).toEqual({ ok: false, reason: 'not_found' });
    const old = await pkgReq(W(20), { now: Date.now() - 49 * HOUR });
    expect(await proof(W(20), old.id)).toEqual({ ok: false, reason: 'expired' });
    expect((await row(old.id))!.state).toBe('awaiting_proof');
  });
});

describe('operator review', () => {
  it('lists proofs under review, shows the proof through a short-lived signed link, and the link stops working', async () => {
    const ws = W(30);
    const r = await pkgReq(ws);
    await proof(ws, r.id, JPG);
    const list = await (await operatorCall(OP1, 'GET', '/instapay?state=under_review')).json() as { items: { id: string; reference: string; workspaceId: string; amountMinor: number }[] };
    expect(list.items.find((i) => i.id === r.id)).toMatchObject({ reference: r.reference, workspaceId: ws, amountMinor: 50000 });
    const link = await (await operatorCall(OP1, 'GET', `/instapay/${r.id}/proof-link`)).json() as { url: string; expiresAt: number };
    expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const res = await SELF.fetch(`https://x${link.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, JPG.length)).toEqual(JPG); // (the upload has 4 random trailing bytes)
    vi.spyOn(Date, 'now').mockReturnValue(link.expiresAt + 1000);
    expect((await SELF.fetch(`https://x${link.url}`)).status).toBe(404);
  });
  it('a store user (not a super admin) cannot reach the operator routes', async () => {
    const owner = await apiFor(W(31));
    const res = await SELF.fetch('https://x/api/v1/operator/instapay', { headers: { authorization: `Bearer ${owner.token}` } });
    expect([401, 403]).toContain(res.status);
    expect((await operatorCall(null, 'GET', '/instapay')).status).toBe(401);
  });
  it('confirming a package grants it exactly once through the purchase path: subscription, order paid, entitlement; a second confirm adds nothing', async () => {
    const ws = W(32);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    const first = await operatorCall(OP1, 'POST', `/instapay/${r.id}/confirm`, {});
    expect(first.status).toBe(200);
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active', source: 'purchase', version: 1 });
    expect(await orderRow('package_orders', r.id)).toEqual({ s: 'paid', provider: 'instapay', ref: `instapay:${r.reference}` });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'gold', version: 1 });
    expect(await row(r.id)).toMatchObject({ state: 'confirmed', decided_by: OP1 });
    expect((await row(r.id))!.granted_at).not.toBeNull();
    const again = await operatorCall(OP2, 'POST', `/instapay/${r.id}/confirm`, {});
    expect(again.status).toBe(409);
    expect(await audits(ws)).toBe(1);
    expect((await sub(ws) as { version: number }).version).toBe(1);
  });
  it('confirming a top-up credits the wallet exactly once with the instapay reference', async () => {
    const ws = W(33);
    const r = await topupReq(ws, 20000);
    await proof(ws, r.id, PDF);
    expect((await operatorCall(OP1, 'POST', `/instapay/${r.id}/confirm`, {})).status).toBe(200);
    await operatorCall(OP2, 'POST', `/instapay/${r.id}/confirm`, {});
    expect((await ledger(ws)).map((x) => [x.kind, x.amount_minor, x.ref])).toEqual([['topup', 20000, `instapay:${r.reference}`]]);
    expect(await orderRow('topups', r.id)).toEqual({ s: 'paid', provider: 'instapay', ref: `instapay:${r.reference}` });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(20000);
  });
  it('maker-checker: the requester cannot confirm or reject their own request', async () => {
    const ws = W(34);
    const r = await pkgReq(ws, { userId: OP1 });
    await proof(ws, r.id);
    expect(await confirmInstapay(env, { id: r.id, actor: OP1 })).toEqual({ ok: false, reason: 'self_approval_refused' });
    expect(await rejectInstapay(env, { id: r.id, actor: OP1, reason: 'no thanks' })).toEqual({ ok: false, reason: 'self_approval_refused' });
    expect((await operatorCall(OP1, 'POST', `/instapay/${r.id}/confirm`, {})).status).toBe(403);
    expect(await sub(ws)).toBeNull();
    expect((await row(r.id))!.state).toBe('under_review');
  });
  it('above ADJUSTMENT_APPROVAL_MINOR a SECOND operator is needed: the first confirm grants nothing, the same operator cannot be both', async () => {
    const ws = W(35);
    const r = await topupReq(ws, 20000);
    await proof(ws, r.id);
    expect(await confirmInstapay(lowThreshold, { id: r.id, actor: OP1 })).toEqual({ ok: false, reason: 'bank_reference_required' }); // two approvals = the bank reference at both (W2-MONEY)
    expect(await confirmInstapay(lowThreshold, { id: r.id, actor: OP1, bankRef: 'BK-35-0001' })).toMatchObject({ ok: true, needsSecond: true });
    expect(await ledger(ws)).toEqual([]);
    expect(await confirmInstapay(lowThreshold, { id: r.id, actor: OP1, bankRef: 'BK-35-0001' })).toEqual({ ok: false, reason: 'second_approver_required' });
    expect(await ledger(ws)).toEqual([]);
    expect(await confirmInstapay(lowThreshold, { id: r.id, actor: OP2, bankRef: 'BK-35-0001' })).toMatchObject({ ok: true });
    expect((await ledger(ws)).map((x) => x.amount_minor)).toEqual([20000]);
    expect((await row(r.id))).toMatchObject({ state: 'confirmed', first_approver: OP1, decided_by: OP2 });
  });
  it('reject needs a reason, tells the merchant why, closes the orders, and a confirm after it is refused', async () => {
    const ws = W(36);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    expect((await operatorCall(OP1, 'POST', `/instapay/${r.id}/reject`, {})).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/instapay/${r.id}/reject`, { reason: 'The amount on the receipt is 400' })).status).toBe(200);
    expect(await orderRow('package_orders', r.id)).toMatchObject({ s: 'failed' });
    const owner = await apiFor(ws);
    const mine = await (await owner.call('GET', '/wallet/instapay')).json() as { items: { id: string; state: string; rejectReason: string | null }[] };
    expect(mine.items.find((i) => i.id === r.id)).toMatchObject({ state: 'rejected', rejectReason: 'The amount on the receipt is 400' });
    expect((await operatorCall(OP2, 'POST', `/instapay/${r.id}/confirm`, {})).status).toBe(409);
    expect(await sub(ws)).toBeNull();
    expect(await rejectInstapay(env, { id: r.id, actor: OP2, reason: 'again' })).toEqual({ ok: false, reason: 'not_reviewable' });
  });
  it('confirm and reject racing each other end in exactly one outcome', async () => {
    const ws = W(37);
    const r = await topupReq(ws, 5000);
    await proof(ws, r.id);
    const [a, b] = await Promise.all([confirmInstapay(env, { id: r.id, actor: OP1 }), rejectInstapay(env, { id: r.id, actor: OP2, reason: 'race' })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const final = (await row(r.id))!.state;
    expect(['confirmed', 'rejected']).toContain(final);
    expect((await ledger(ws)).length).toBe(final === 'confirmed' ? 1 : 0);
  });
  it('a mismatch between the request and its order (tampered row) is refused and grants nothing', async () => {
    const ws = W(38);
    const r = await topupReq(ws, 20000);
    await proof(ws, r.id);
    await env.DB.prepare('UPDATE instapay_requests SET amount_minor = 99999 WHERE id = ?').bind(r.id).run();
    expect(await confirmInstapay(env, { id: r.id, actor: OP1 })).toEqual({ ok: false, reason: 'amount_mismatch' });
    expect(await ledger(ws)).toEqual([]);
    expect((await row(r.id))!.state).toBe('under_review');
  });
});

describe('expiry', () => {
  it('48 h without a proof expires the request and its order; a proof already in is never expired by the clock; upload and expiry racing end in one outcome', async () => {
    const stale = await pkgReq(W(40), { now: Date.now() - 49 * HOUR });
    const waiting = await topupReq(W(41), 5000, { now: Date.now() - 49 * HOUR - 1000 });
    await env.DB.prepare('UPDATE instapay_requests SET state = ?, proof_key = ?, proof_at = ? WHERE id = ?').bind('under_review', 'k', Date.now() - 50 * HOUR, waiting.id).run();
    expect(await expireInstapay(env)).toMatchObject({ expired: expect.any(Number) });
    expect((await row(stale.id))!.state).toBe('expired');
    expect(await orderRow('package_orders', stale.id)).toMatchObject({ s: 'expired' });
    expect((await row(waiting.id))!.state).toBe('under_review');
    // a confirm still works on it
    expect((await confirmInstapay(env, { id: waiting.id, actor: OP1 })).ok).toBe(true);
    // upload racing the expiry: the expiry wins when it lands first
    const ws = W(42);
    const r = await pkgReq(ws, { now: Date.now() - 48 * HOUR + 50 });
    const interleaved = { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'batch') return async (s: D1PreparedStatement[]) => t.batch(s); const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
    const later = Date.now() + 100;
    await expireInstapay(interleaved, later); // the clock passed the deadline between the upload's check and its write
    const out = await storeProof(interleaved, { workspaceId: ws, requestId: r.id, sessionId: 's1', bytes: bytes(PNG), contentType: 'image/png' }, later);
    expect(out.ok).toBe(false);
    expect((await row(r.id))!.state).toBe('expired');
    expect(await env.MEDIA.list({ prefix: `instapay-proof/${ws}/` }).then((l) => l.objects.length)).toBe(0);
  });
  it('the daily pass runs the expiry', async () => {
    const r = await pkgReq(W(43), { now: Date.now() - 50 * HOUR });
    await dailyBilling(env);
    expect((await row(r.id))!.state).toBe('expired');
  });
  it('the Kashier repair passes leave InstaPay orders alone: no 24 h expiry, no inquiry, no 7-day topup expiry', async () => {
    const p = await pkgReq(W(44), { now: Date.now() - 30 * HOUR });
    const t = await topupReq(W(45), 5000, { now: Date.now() - 8 * 86_400_000 });
    await repairPackageOrders(env, Date.now(), testKashier());
    await repairTopups(env, testKashier());
    expect(await orderRow('package_orders', p.id)).toMatchObject({ s: 'pending' });
    expect(await orderRow('topups', t.id)).toMatchObject({ s: 'pending' });
  });
  it('a confirmed request whose grant did not finish is completed by the daily repair', async () => {
    const ws = W(46);
    const r = await topupReq(ws, 5000);
    await proof(ws, r.id);
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = ?, decided_at = ? WHERE id = ?").bind(OP1, Date.now(), r.id).run();
    expect(await ledger(ws)).toEqual([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await repairInstapay(env);
    await repairInstapay(env);
    expect((await ledger(ws)).map((x) => x.amount_minor)).toEqual([5000]);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('instapay_confirmed_not_granted'))).toHaveLength(1);
  });
});

describe('the review SLA: 4 business hours, Sunday to Thursday 09:00-17:00 Africa/Cairo', () => {
  const cairo = (iso: string) => Date.parse(iso);
  const H = HOUR;
  it('counts only business hours, skips Friday and Saturday, and follows Cairo daylight saving', () => {
    // summer (UTC+3): Thursday 16:00 -> Sunday 11:00 = 1 h Thursday + 2 h Sunday
    expect(businessMsBetween(cairo('2026-07-02T13:00:00Z'), cairo('2026-07-05T08:00:00Z'))).toBe(3 * H);
    expect(businessMsBetween(cairo('2026-07-02T13:00:00Z'), cairo('2026-07-05T09:30:00Z'))).toBe(4.5 * H);
    // a pure weekend
    expect(businessMsBetween(cairo('2026-07-03T07:00:00Z'), cairo('2026-07-04T17:00:00Z'))).toBe(0);
    // winter (UTC+2): Thursday 16:30 -> Sunday 10:00
    expect(businessMsBetween(cairo('2026-12-03T14:30:00Z'), cairo('2026-12-06T08:00:00Z'))).toBe(1.5 * H);
    // across the end of daylight saving (Cairo clocks go back after Thursday 2026-10-29): Thursday 16:00 (+3) -> Sunday 10:00 (+2)
    expect(businessMsBetween(cairo('2026-10-29T13:00:00Z'), cairo('2026-11-01T08:00:00Z'))).toBe(2 * H);
    // outside hours and the other way round
    expect(businessMsBetween(cairo('2026-07-05T03:00:00Z'), cairo('2026-07-05T05:30:00Z'))).toBe(0); // Sunday 06:00-08:30 Cairo
    expect(businessMsBetween(cairo('2026-07-05T08:00:00Z'), cairo('2026-07-02T13:00:00Z'))).toBe(0);
    // a full working day
    expect(businessMsBetween(cairo('2026-07-05T00:00:00Z'), cairo('2026-07-05T23:00:00Z'))).toBe(8 * H);
  });
  it('alerts instapay_proof_overdue once per proof, after 4 business hours, in the repo\'s alert line format', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = W(50);
    const r = await pkgReq(ws, { now: cairo('2027-07-01T13:00:00Z') });
    await proof(ws, r.id, PNG, cairo('2027-07-01T13:00:00Z')); // Thursday 16:00 Cairo
    const n = () => spy.mock.calls.filter((c) => String(c[0]).includes('instapay_proof_overdue') && String(c[0]).includes(r.id)).length;
    await overdueInstapay(env, cairo('2027-07-04T08:00:00Z')); // Sunday 11:00: 3 business hours
    expect(n()).toBe(0);
    await overdueInstapay(env, cairo('2027-07-04T09:30:00Z')); // Sunday 12:30: 4.5 business hours
    expect(n()).toBe(1);
    expect(String(spy.mock.calls.find((c) => String(c[0]).includes('instapay_proof_overdue') && String(c[0]).includes(r.id))![0])).toContain('"severity":"P1"');
    await overdueInstapay(env, cairo('2027-07-05T09:30:00Z'));
    expect(n()).toBe(1);
  });
});

describe('review round (Opus check of item i)', () => {
  const cairo = (iso: string) => Date.parse(iso);

  it('IMPORTANT: two concurrent uploads for one request leave exactly one stored proof, and it is the one the row points to and the operator can read', async () => {
    const ws = W(60);
    const r = await pkgReq(ws);
    const [a, b] = await Promise.all([proof(ws, r.id, PNG), proof(ws, r.id, JPG)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const objects = await env.MEDIA.list({ prefix: `instapay-proof/${ws}/` });
    expect(objects.objects).toHaveLength(1);
    const key = (await row(r.id))!.proof_key!;
    expect(objects.objects[0]!.key).toBe(key);
    expect(await env.MEDIA.get(key)).not.toBeNull();
    const link = await (await operatorCall(OP1, 'GET', `/instapay/${r.id}/proof-link`)).json() as { url: string };
    expect((await SELF.fetch(`https://x${link.url}`)).status).toBe(200);
  });

  it('IMPORTANT: the SLA deadline is scheduled when the proof arrives (4 business hours, Cairo), fires once if still under review, never if it was decided', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = W(61);
    const r = await pkgReq(ws, { now: cairo('2027-07-01T13:00:00Z') });
    await proof(ws, r.id, PNG, cairo('2027-07-01T13:00:00Z')); // Thursday 16:00 Cairo: 1 h that day + 3 h on Sunday
    const due = cairo('2027-07-04T09:00:00Z'); // Sunday 12:00 Cairo
    expect((await rows<{ kind: string; due_at: number; payload: string }>(ws, "SELECT kind, due_at, payload FROM scheduled_tasks WHERE kind = 'instapay_overdue'"))).toEqual([{ kind: 'instapay_overdue', due_at: due, payload: JSON.stringify({ instapayRequestId: r.id }) }]);
    const fired = () => spy.mock.calls.filter((c) => String(c[0]).includes('instapay_proof_overdue') && String(c[0]).includes(r.id)).length;
    await workspace(ws).runDueTasks(due - 1);
    expect(fired()).toBe(0);
    await workspace(ws).runDueTasks(due + 1);
    expect(fired()).toBe(1);
    await overdueInstapay(env, due + 2 * HOUR); // the daily backstop does not repeat it
    expect(fired()).toBe(1);
    const decided = await pkgReq(W(62), { now: cairo('2027-07-01T13:00:00Z') });
    await proof(W(62), decided.id, PNG, cairo('2027-07-01T13:00:00Z'));
    await confirmInstapay(env, { id: decided.id, actor: OP1 });
    await workspace(W(62)).runDueTasks(due + 1);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('instapay_proof_overdue') && String(c[0]).includes(decided.id))).toHaveLength(0);
  });

  it('addBusinessMs lands on the right business moment: Thursday evening, Friday, before opening, after closing', () => {
    expect(new Date(addBusinessMs(cairo('2026-07-02T13:00:00Z'), 4 * HOUR)).toISOString()).toBe('2026-07-05T09:00:00.000Z'); // Thu 16:00 -> Sun 12:00
    expect(new Date(addBusinessMs(cairo('2026-07-03T07:00:00Z'), 4 * HOUR)).toISOString()).toBe('2026-07-05T10:00:00.000Z'); // Fri 10:00 -> Sun 13:00
    expect(new Date(addBusinessMs(cairo('2026-07-05T05:00:00Z'), 4 * HOUR)).toISOString()).toBe('2026-07-05T10:00:00.000Z'); // Sun 08:00 -> Sun 13:00
    expect(new Date(addBusinessMs(cairo('2026-07-05T12:00:00Z'), 4 * HOUR)).toISOString()).toBe('2026-07-06T08:00:00.000Z'); // Sun 15:00 -> Mon 11:00
    expect(new Date(addBusinessMs(cairo('2026-12-03T14:30:00Z'), 4 * HOUR)).toISOString()).toBe('2026-12-06T10:30:00.000Z'); // winter Thu 16:30 -> Sun 12:30
  });

  it('IMPORTANT: a rejection reaches the merchant in the app: the wallet carries a notice until the owner has seen it, with the reason (in-app only: no utility template exists)', async () => {
    const ws = W(63);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    await rejectInstapay(env, { id: r.id, actor: OP1, reason: 'The receipt is for another amount' });
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await (await staff.call('GET', '/wallet')).json() as { instapayNotice?: unknown }).instapayNotice ?? null).toBeNull(); // staff do not see payment details
    expect((await (await owner.call('GET', '/wallet')).json() as { instapayNotice: { id: string; reason: string } }).instapayNotice).toEqual({ id: r.id, reason: 'The receipt is for another amount' });
    expect((await owner.call('GET', '/wallet/instapay')).status).toBe(200); // opening the card = seen
    expect((await (await owner.call('GET', '/wallet')).json() as { instapayNotice?: unknown }).instapayNotice ?? null).toBeNull();
  });

  it('MINOR: the five-open-requests cap holds under concurrent creates, and no orphan order is left', async () => {
    const ws = W(64);
    await seedNumber('pn-ip-w64', ws);
    const make = () => createInstapayRequest(env, { workspaceId: ws, userId: 'm', sessionId: 's', input: { kind: 'topup', amountMinor: 5000 }, payee: PAYEE });
    const out = await Promise.all(Array.from({ length: 9 }, make));
    expect(out.filter((x) => x.ok)).toHaveLength(5);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM instapay_requests WHERE workspace_id = ?").bind(ws).first<{ n: number }>())!.n).toBe(5);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM topups WHERE workspace_id = ? AND provider = 'instapay'").bind(ws).first<{ n: number }>())!.n).toBe(5);
  });

  it('MINOR: the repair failure alert fires once per request, not on every daily pass', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = W(65);
    const r = await topupReq(ws, 5000);
    await proof(ws, r.id);
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = ?, decided_at = 1 WHERE id = ?").bind(OP1, r.id).run();
    await env.DB.prepare('DELETE FROM topups WHERE order_id = ?').bind(r.id).run(); // the grant cannot complete
    await repairInstapay(env);
    await repairInstapay(env);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('instapay_repair_failed') && String(c[0]).includes(r.id))).toHaveLength(1);
  });

  it('MINOR: the operator proof link re-checks the session (revocation) because proof images are personal data; so does the review list', async () => {
    const ws = W(66);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    configureSessionCheck(async () => true);
    expect((await operatorCall(OP1, 'GET', `/instapay/${r.id}/proof-link`)).status).toBe(403);
    expect((await operatorCall(OP1, 'GET', '/instapay')).status).toBe(403);
    configureSessionCheck(async () => false);
    expect((await operatorCall(OP1, 'GET', `/instapay/${r.id}/proof-link`)).status).toBe(200);
  });

  it('MINOR: the proof link is signed with its own derived key: a token made with the raw TOKEN_ENC_KEY is refused', async () => {
    const ws = W(67);
    const r = await pkgReq(ws);
    await proof(ws, r.id);
    const exp = Date.now() + 60_000;
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TOKEN_ENC_KEY!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const raw = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`instapay-proof:v1:${r.id}.${exp}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((await SELF.fetch(`https://x/api/v1/instapay-proof/${r.id}.${exp}.${raw}`)).status).toBe(404);
    const link = await (await operatorCall(OP1, 'GET', `/instapay/${r.id}/proof-link`)).json() as { url: string };
    expect((await SELF.fetch(`https://x${link.url}`)).status).toBe(200);
  });

  it('MINOR: a PDF proof is served as an attachment (sandboxed inline PDFs do not render in Chrome); images stay inline', async () => {
    const a = await pkgReq(W(68));
    await proof(W(68), a.id, PDF);
    const b = await pkgReq(W(69));
    await proof(W(69), b.id, PNG);
    const get = async (id: string) => SELF.fetch(`https://x${((await (await operatorCall(OP1, 'GET', `/instapay/${id}/proof-link`)).json()) as { url: string }).url}`);
    expect((await get(a.id)).headers.get('content-disposition')).toContain('attachment');
    expect((await get(b.id)).headers.get('content-disposition')).toBe('inline');
  });

  it('a lapsed shared-number member can send free-form text only inside ITS OWN 24 h window with that customer', async () => {
    const ws = W(70);
    const owner = await apiFor(ws);
    await workspace(ws).applyEntitlement({ version: 99, packageId: 'gold', status: 'past_due', periodStart: 1, periodEnd: Date.now() + DAYMS });
    const closed = await openChat(ws, '201001230001', { ts: Math.floor(Date.now() / 1000) - 25 * 3600 }); // the window (opened by an inbound of ITS OWN) is over
    const open = await openChat(ws, '201001230002');
    const text = (n: number) => ({ type: 'text', clientId: `00000000-0000-4000-8000-00000000007${n}`, text: 'x' });
    expect((await owner.call('POST', `/conversations/${closed}/messages`, text(1))).status).toBe(409);
    expect((await owner.call('POST', `/conversations/${open}/messages`, text(2))).status).toBe(202);
  });
});
const DAYMS = 86_400_000;

