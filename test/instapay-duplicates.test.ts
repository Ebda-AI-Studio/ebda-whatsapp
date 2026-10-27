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
const W = (n: number) => W0(9800 + n);
const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };
beforeEach(async () => {
  configureSessionCheck(async () => false);
  configurePayments(() => testKashier());
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

/** A PNG whose bytes are decided by `tag`: the same tag = the same image. */
const png = (tag: string) => { const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(tag)]); return b.buffer.slice(0) as ArrayBuffer; };
const req = async (ws: string) => {
  await seedNumber(`pn-dup-${ws.slice(-6)}`, ws);
  const r = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'topup', amountMinor: 20000 }, payee: PAYEE });
  if (!r.ok) throw new Error(r.reason);
  return r.request;
};
const upload = (ws: string, id: string, tag: string) => storeProof(env, { workspaceId: ws, requestId: id, sessionId: 's1', bytes: png(tag), contentType: 'image/png' });
const state = (id: string) => env.DB.prepare('SELECT state, held_reason, held_of, proof_sha256, bank_ref FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; held_reason: string | null; held_of: string | null; proof_sha256: string | null; bank_ref: string | null }>();
const alerts = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });

describe('the same proof image (C2)', () => {
  it('two requests in DIFFERENT workspaces with the same image are both held and an alert is raised; a different image is not held', async () => {
    const spy = vi.spyOn(console, 'error');
    const a = await req(W(1));
    const b = await req(W(2));
    const c = await req(W(3));
    await upload(W(1), a.id, 'same-image');
    expect((await state(a.id))!.held_reason).toBeNull(); // the first of its kind is not held
    await upload(W(2), b.id, 'same-image');
    expect(await state(b.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_image', held_of: a.id });
    expect((await state(a.id))!.held_reason).toBe('duplicate_image'); // the earlier one is still under review: neither may be confirmed until a person looks
    await upload(W(3), c.id, 'another-image');
    expect((await state(c.id))!.held_reason).toBeNull();
    expect(alerts(spy)).toContain('instapay_duplicate_proof');
    expect((await state(a.id))!.proof_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('when the earlier request was already CONFIRMED only the new one is held', async () => {
    const a = await req(W(4));
    const b = await req(W(5));
    await upload(W(4), a.id, 'paid-once');
    expect((await confirmInstapay(env, { id: a.id, actor: OP1 })).ok).toBe(true);
    await upload(W(5), b.id, 'paid-once');
    expect((await state(b.id))!.held_reason).toBe('duplicate_image');
    expect((await state(a.id))!.state).toBe('confirmed');
  });

  it('the same workspace sending one transfer image for two requests is held too', async () => {
    const a = await req(W(6));
    const b = await req(W(6));
    await upload(W(6), a.id, 'twice-in-one');
    await upload(W(6), b.id, 'twice-in-one');
    expect((await state(b.id))!.held_reason).toBe('duplicate_image');
  });

  it('a held request cannot be confirmed, can be rejected, and is released only by an operator with a reason; then it confirms once', async () => {
    const a = await req(W(7));
    const b = await req(W(8));
    await upload(W(7), a.id, 'dup-held');
    await upload(W(8), b.id, 'dup-held');
    expect(await confirmInstapay(env, { id: b.id, actor: OP1 })).toEqual({ ok: false, reason: 'held' });
    expect((await state(b.id))!.state).toBe('under_review');
    expect(await releaseInstapay(env, { id: b.id, actor: 'merchant-1', reason: 'looks fine' })).toEqual({ ok: false, reason: 'self_approval_refused' });
    expect(await releaseInstapay(env, { id: b.id, actor: OP1, reason: 'x' })).toEqual({ ok: false, reason: 'reason_required' });
    expect((await releaseInstapay(env, { id: b.id, actor: OP1, reason: 'different transfers, checked both in the bank app' })).ok).toBe(true);
    expect((await state(b.id))!.held_reason).toBeNull();
    expect((await confirmInstapay(env, { id: b.id, actor: OP2 })).ok).toBe(true);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'instapay_released'").first<{ n: number }>())!.n).toBeGreaterThan(0);
    // the other can still simply be rejected while held
    expect((await rejectInstapay(env, { id: a.id, actor: OP1, reason: 'duplicate of another transfer' })).ok).toBe(true);
  });
});

describe('the same bank reference (C2)', () => {
  it('confirming with a bank reference already used by another request (any workspace, spacing and case ignored) is refused and holds the request', async () => {
    const spy = vi.spyOn(console, 'error');
    const a = await req(W(9));
    const b = await req(W(10));
    await upload(W(9), a.id, 'ref-a');
    await upload(W(10), b.id, 'ref-b');
    expect((await confirmInstapay(env, { id: a.id, actor: OP1, bankRef: 'ip 4471 0098 xyz' })).ok).toBe(true);
    expect(await state(a.id)).toMatchObject({ bank_ref: 'IP44710098XYZ' });
    expect(await confirmInstapay(env, { id: b.id, actor: OP1, bankRef: 'IP4471 0098 XYZ' })).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await state(b.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_reference', held_of: a.id });
    expect(alerts(spy)).toContain('instapay_duplicate_proof');
    // a different reference on a release goes through
    await releaseInstapay(env, { id: b.id, actor: OP1, reason: 'typed the wrong reference, the right one is below' });
    expect((await confirmInstapay(env, { id: b.id, actor: OP2, bankRef: 'IP9999' })).ok).toBe(true);
  });

  it('a confirmation without a bank reference still works (optional), and a malformed reference is refused', async () => {
    const a = await req(W(11));
    await upload(W(11), a.id, 'no-ref');
    expect(await confirmInstapay(env, { id: a.id, actor: OP1, bankRef: '!!' })).toEqual({ ok: false, reason: 'bad_reference' });
    expect((await confirmInstapay(env, { id: a.id, actor: OP1 })).ok).toBe(true);
  });
});

describe('over HTTP', () => {
  it('the queue shows the hold and its twin; confirm answers 409 held; release needs a reason', async () => {
    const a = await req(W(12));
    const b = await req(W(13));
    await upload(W(12), a.id, 'http-dup');
    await upload(W(13), b.id, 'http-dup');
    const list = (await (await operatorCall(OP1, 'GET', '/instapay?state=under_review')).json()) as { items: { id: string; heldReason: string | null; heldOf: string | null }[] };
    expect(list.items.find((i) => i.id === b.id)).toMatchObject({ heldReason: 'duplicate_image', heldOf: a.id });
    const c = await operatorCall(OP1, 'POST', `/instapay/${b.id}/confirm`, {});
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ message: 'held' });
    expect((await operatorCall(OP1, 'POST', `/instapay/${b.id}/release`, {})).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/instapay/${b.id}/release`, { reason: 'verified both transfers separately' })).status).toBe(200);
    expect((await operatorCall(OP2, 'POST', `/instapay/${b.id}/confirm`, { bankRef: 'HTTP-REF-1' })).status).toBe(200);
  });
});

const low = { ...env, ADJUSTMENT_APPROVAL_MINOR: '10000' } as typeof env; // the 200 EGP top-ups need two operators here
const OP3 = '33333333-3333-4333-8333-333333333333';

describe('review findings: separation of duties, the bank reference across two approvals, an atomic hold', () => {
  it('the operator who RELEASES a held duplicate can neither first-approve nor confirm it; another operator can', async () => {
    const a = await req(W(20));
    const b = await req(W(21));
    await upload(W(20), a.id, 'sod-dup');
    await upload(W(21), b.id, 'sod-dup');
    expect((await releaseInstapay(env, { id: b.id, actor: OP1, reason: 'checked both transfers in the bank app' })).ok).toBe(true);
    expect(await state(b.id)).toMatchObject({ held_reason: null });
    expect(await confirmInstapay(env, { id: b.id, actor: OP1 })).toEqual({ ok: false, reason: 'releaser_cannot_approve' });
    expect((await env.DB.prepare('SELECT released_by FROM instapay_requests WHERE id = ?').bind(b.id).first<{ released_by: string }>())!.released_by).toBe(OP1);
    expect((await confirmInstapay(env, { id: b.id, actor: OP2 })).ok).toBe(true);
    // and as a FIRST approval of a two-approval amount
    const c = await req(W(22));
    const d = await req(W(23));
    await upload(W(22), c.id, 'sod-two');
    await upload(W(23), d.id, 'sod-two');
    await releaseInstapay(low, { id: d.id, actor: OP1, reason: 'checked both transfers in the bank app' });
    expect(await confirmInstapay(low, { id: d.id, actor: OP1, bankRef: 'SOD-REF-1' })).toEqual({ ok: false, reason: 'releaser_cannot_approve' });
    expect(await confirmInstapay(low, { id: d.id, actor: OP2, bankRef: 'SOD-REF-1' })).toMatchObject({ ok: true, needsSecond: true });
    expect(await confirmInstapay(low, { id: d.id, actor: OP1, bankRef: 'SOD-REF-1' })).toEqual({ ok: false, reason: 'releaser_cannot_approve' }); // not as the second approver either
    expect(await confirmInstapay(low, { id: d.id, actor: OP3, bankRef: 'SOD-REF-1' })).toMatchObject({ ok: true });
  });

  it('a two-approval amount needs the bank reference at the FIRST approval, kept for the second, who must give the same one; the duplicate check runs at both', async () => {
    const a = await req(W(24));
    const b = await req(W(25));
    await upload(W(24), a.id, 'two-a');
    await upload(W(25), b.id, 'two-b');
    expect(await confirmInstapay(low, { id: a.id, actor: OP1 })).toEqual({ ok: false, reason: 'bank_reference_required' });
    expect(await confirmInstapay(low, { id: a.id, actor: OP1, bankRef: 'ip 5500 7766' })).toMatchObject({ ok: true, needsSecond: true });
    expect((await env.DB.prepare('SELECT pending_bank_ref FROM instapay_requests WHERE id = ?').bind(a.id).first<{ pending_bank_ref: string }>())!.pending_bank_ref).toBe('IP55007766');
    expect(await confirmInstapay(low, { id: a.id, actor: OP2 })).toEqual({ ok: false, reason: 'bank_reference_required' }); // the second approver reads it from the proof too
    expect(await confirmInstapay(low, { id: a.id, actor: OP2, bankRef: 'IP5500-9999' })).toEqual({ ok: false, reason: 'reference_mismatch' });
    expect((await state(a.id))!.state).toBe('under_review');
    expect(await confirmInstapay(low, { id: a.id, actor: OP2, bankRef: 'IP5500 7766' })).toMatchObject({ ok: true });
    expect(await state(a.id)).toMatchObject({ state: 'confirmed', bank_ref: 'IP55007766' });
    // a reference already used elsewhere, given at the FIRST approval, holds the request at once
    expect(await confirmInstapay(low, { id: b.id, actor: OP1, bankRef: 'IP5500-7766' })).toEqual({ ok: false, reason: 'duplicate_reference' });
    expect(await state(b.id)).toMatchObject({ held_reason: 'duplicate_reference', held_of: a.id });
  });

  it('the hold is set in the SAME statement as the upload: even when the follow-up write fails the new duplicate is held', async () => {
    const a = await req(W(26));
    const b = await req(W(27));
    await upload(W(26), a.id, 'atomic');
    vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('d1 blinked')); // the old shape's second write
    const res = await upload(W(27), b.id, 'atomic');
    expect(res.ok).toBe(true);
    expect(await state(b.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_image', held_of: a.id });
  });

  it('confirm re-checks twins before claiming: an unheld twin (the old failure shape) is refused and held now', async () => {
    const a = await req(W(28));
    const b = await req(W(29));
    await upload(W(28), a.id, 'recheck');
    await upload(W(29), b.id, 'recheck');
    await env.DB.prepare('UPDATE instapay_requests SET held_reason = NULL, held_of = NULL, held_at = NULL WHERE id IN (?, ?)').bind(a.id, b.id).run(); // simulate holds that never got written
    expect(await confirmInstapay(env, { id: a.id, actor: OP1 })).toEqual({ ok: false, reason: 'held' });
    expect((await state(a.id))!.held_reason).toBe('duplicate_image');
    expect((await state(a.id))!.state).toBe('under_review');
  });
});
