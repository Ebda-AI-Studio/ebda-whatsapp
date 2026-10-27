import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmInstapay, createInstapayRequest, rejectInstapay, releaseInstapay, storeProof } from '../src/core/billing/instapay';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, OP2, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { seedNumber } from './helpers/workspace';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9850 + n);
const OP3 = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;
const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };
beforeEach(() => { configureSessionCheck(async () => false); configurePayments(() => testKashier()); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const png = (tag: string) => { const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(tag)]); return b.buffer.slice(0) as ArrayBuffer; };
const req = async (ws: string, amountMinor: number, tag: string) => {
  await seedNumber(`pn-ir-${ws.slice(-6)}`, ws);
  const r = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'topup', amountMinor }, payee: PAYEE });
  if (!r.ok) throw new Error(r.reason);
  const p = await storeProof(env, { workspaceId: ws, requestId: r.request.id, sessionId: 's1', bytes: png(tag), contentType: 'image/png' });
  if (!p.ok) throw new Error(p.reason);
  return r.request;
};
const row = (id: string) => env.DB.prepare('SELECT state, held_reason, held_of, bank_ref, no_reference, pending_bank_ref FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; held_reason: string | null; held_of: string | null; bank_ref: string | null; no_reference: number; pending_bank_ref: string | null }>();
const alerts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });

describe('item 7 (DUP-REF-REQUIRED-1): the bank reference is required at confirmation, for every amount', () => {
  it('900 EGP confirmed three times with re-encoded screenshots: the reference is required, so the same transfer cannot be paid out 3x', async () => {
    const ws = W(1);
    const [a, b, c] = [await req(ws, 90_000, 'shot-1'), await req(ws, 90_000, 'shot-2'), await req(ws, 90_000, 'shot-3')]; // three different images of ONE transfer
    for (const r of [a!, b!, c!]) expect(await confirmInstapay(env, { id: r.id, actor: OP1 })).toEqual({ ok: false, reason: 'bank_reference_required' });
    expect(await confirmInstapay(env, { id: a!.id, actor: OP1, bankRef: 'BK 900 777' })).toMatchObject({ ok: true });
    expect(await confirmInstapay(env, { id: b!.id, actor: OP1, bankRef: 'bk-900-777' })).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await confirmInstapay(env, { id: c!.id, actor: OP1, bankRef: 'BK900777' })).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect((await row(b!.id))!.held_reason).toBe('duplicate_reference');
  });

  it('noReference needs the ticked flag AND a reason; it is audited, raises an INFO alert and is stored; a typed reference and the flag together are refused', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(2);
    const a = await req(ws, 20_000, 'nr-a');
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, noReference: { reason: 'x' } })).toEqual({ ok: false, reason: 'reason_required' });
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, bankRef: 'REF-NR-1', noReference: { reason: 'the proof shows no number at all' } })).toEqual({ ok: false, reason: 'bad_reference' });
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, noReference: { reason: 'the proof shows no number at all' } })).toMatchObject({ ok: true });
    expect(await row(a.id)).toMatchObject({ state: 'confirmed', bank_ref: null, no_reference: 1 });
    expect(alerts(spy)).toContain('instapay_no_reference');
    const audited = await env.DB.prepare("SELECT r.reason, b.after_json FROM billing_audit b JOIN audit_reasons r ON r.id = b.reason_id WHERE b.action = 'instapay_confirmed' AND b.after_json LIKE ?").bind(`%${a.id}%`).first<{ reason: string; after_json: string }>();
    expect(audited).toMatchObject({ reason: 'the proof shows no number at all' });
    expect(audited!.after_json).toContain('"noReference":true');
  });

  it('two no-reference confirms for the same workspace and amount within 7 days: the SECOND is held (P1); another amount, another workspace or 8 days later is not', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(3);
    const why = { reason: 'the proof shows no number at all' };
    const [a, b, c, d, e] = [await req(ws, 30_000, 'h-a'), await req(ws, 30_000, 'h-b'), await req(ws, 31_000, 'h-c'), await req(W(4), 30_000, 'h-d'), await req(ws, 30_000, 'h-e')];
    const t0 = Date.now();
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, noReference: why }, t0)).toMatchObject({ ok: true });
    expect(await confirmInstapay(env, { id: b.id, actor: OP2, noReference: why }, t0 + 1000)).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await row(b.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_reference', held_of: a.id });
    expect(alerts(spy)).toContain('instapay_duplicate_proof');
    expect(await confirmInstapay(env, { id: c.id, actor: OP2, noReference: why }, t0 + 1000)).toMatchObject({ ok: true });
    expect(await confirmInstapay(env, { id: d.id, actor: OP2, noReference: why }, t0 + 1000)).toMatchObject({ ok: true });
    expect(await confirmInstapay(env, { id: e.id, actor: OP3, noReference: why }, t0 + 8 * DAY)).toMatchObject({ ok: true });
  });

  it('a two-approval amount cannot skip the reference', async () => {
    const low = { ...env, ADJUSTMENT_APPROVAL_MINOR: '1000' } as typeof env;
    const a = await req(W(5), 20_000, 'two-nr');
    expect(await confirmInstapay(low, { id: a.id, actor: OP1, noReference: { reason: 'the proof shows no number at all' } })).toEqual({ ok: false, reason: 'bank_reference_required' });
  });

  it('over HTTP: confirm with {} is refused (409 bank_reference_required); {noReference: true, reason} is accepted; a flag without a reason is a 400', async () => {
    const a = await req(W(6), 20_000, 'http-nr');
    const none = await operatorCall(OP1, 'POST', `/instapay/${a.id}/confirm`, {});
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ message: 'bank_reference_required' });
    expect((await operatorCall(OP1, 'POST', `/instapay/${a.id}/confirm`, { noReference: true })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/instapay/${a.id}/confirm`, { noReference: true, reason: 'the proof shows no number at all' })).status).toBe(200);
  });
});

describe('security review: two CONCURRENT no-reference confirms credit once', () => {
  it('the pre-check misses (a race): the claim UPDATE itself refuses the second one, which is held; only one credit is made', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(8);
    const a = await req(ws, 30_000, 'race-a');
    const b = await req(ws, 30_000, 'race-b');
    const why = { reason: 'the proof shows no number at all' };
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, noReference: why })).toMatchObject({ ok: true });
    const real = env.DB.prepare.bind(env.DB);
    let missed = false;
    vi.spyOn(env.DB, 'prepare').mockImplementation(((sql: string) => {
      if (!missed && /no_reference = 1 AND state = 'confirmed'/.test(sql) && /ORDER BY decided_at LIMIT 1/.test(sql)) { missed = true; return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement; }
      return real(sql);
    }) as typeof env.DB.prepare);
    const res = await confirmInstapay(env, { id: b.id, actor: OP2, noReference: why });
    expect(missed).toBe(true);
    expect(res).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await row(b.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_reference', held_of: a.id, no_reference: 0 });
    expect(alerts(spy)).toContain('instapay_duplicate_proof');
    const credits = await env.DB.prepare("SELECT count(*) AS n FROM topups WHERE order_id IN (?, ?) AND state = 'paid'").bind(a.id, b.id).first<{ n: number }>();
    expect(credits!.n).toBe(1);
  });
});

describe('AUDIT-REASONS-1: instapay_releases holds no text', () => {
  it('a release reason with a phone number is in audit_reasons only; the row points at it', async () => {
    const a = await req(W(20), 20_000, 'rel-same');
    const b = await req(W(21), 20_000, 'rel-same'); // the same image: held
    expect((await row(b.id))!.held_reason).toBe('duplicate_image');
    expect((await releaseInstapay(env, { id: b.id, actor: OP1, reason: 'checked: customer 01001234567 sent both on purpose' })).ok).toBe(true);
    const rel = await env.DB.prepare('SELECT * FROM instapay_releases WHERE request_id = ?').bind(b.id).first<Record<string, unknown>>();
    expect(JSON.stringify(rel)).not.toContain('01001234567');
    expect(rel).toMatchObject({ reason: 'see reason_id' });
    expect(rel!.reason_id).not.toBeNull();
    expect((await env.DB.prepare('SELECT reason FROM audit_reasons WHERE id = ?').bind(rel!.reason_id).first<{ reason: string }>())!.reason).toContain('01001234567');
    void a;
  });
});

describe('item 14: a rejected request frees its reference', () => {
  const low = { ...env, ADJUSTMENT_APPROVAL_MINOR: '1000' } as typeof env;
  it('a first approval records pending_bank_ref; the rejection clears it, so the same reference confirms on another request', async () => {
    const a = await req(W(10), 20_000, 'pb-a');
    const b = await req(W(11), 20_000, 'pb-b');
    expect(await confirmInstapay(low, { id: a.id, actor: OP1, bankRef: 'PB-REF-14' })).toMatchObject({ ok: true, needsSecond: true });
    expect((await row(a.id))!.pending_bank_ref).toBe('PBREF14');
    expect((await rejectInstapay(env, { id: a.id, actor: OP2, reason: 'the transfer never arrived' })).ok).toBe(true);
    expect((await row(a.id))!.pending_bank_ref).toBeNull();
    expect(await confirmInstapay(low, { id: b.id, actor: OP1, bankRef: 'PB-REF-14' })).toMatchObject({ ok: true, needsSecond: true });
    expect(await confirmInstapay(low, { id: b.id, actor: OP2, bankRef: 'PB-REF-14' })).toMatchObject({ ok: true });
  });

  it('the duplicate check ignores a terminal row even if it still carries the reference (rows written before the fix)', async () => {
    const a = await req(W(12), 20_000, 'pt-a');
    const b = await req(W(13), 20_000, 'pt-b');
    await env.DB.prepare("UPDATE instapay_requests SET state = 'rejected', pending_bank_ref = 'LEGACYREF' WHERE id = ?").bind(a.id).run();
    expect(await confirmInstapay(env, { id: b.id, actor: OP1, bankRef: 'LEGACY-REF' })).toMatchObject({ ok: true });
  });
});
