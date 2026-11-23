import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instapayRequestDto } from '../src/core/api/contract';
import { CONTEST_WINDOW_MS, cancelInstapay, confirmInstapay, contestInstapay, expireInstapay, rejectInstapay } from '../src/core/billing/instapay';
import { autoConfirmInstapay, sweepAutoConfirm } from '../src/core/billing/instapay-auto';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, OP2, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { aiCalls, aiEnv, autoRow, goodAnswer, request, reqRow, seedGold, seedSub, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';

// Self-service gap #3 (Chat half): the owner cancels a proof-less InstaPay request and contests a rejection once. Neither can confirm or credit anything.
useApiKey();
useStoreLink();
const W = (n: number) => W0(9900 + n);
const PNG = (tag: string) => { const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(tag)]); return b.buffer.slice(0) as ArrayBuffer; };
beforeEach(() => { configureSessionCheck(async () => false); configurePayments(() => testKashier()); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

type Api = Awaited<ReturnType<typeof apiFor>>;
const create = async (api: Api, kind: 'topup' | 'package' = 'topup') => {
  const r = await api.call('POST', '/wallet/instapay', kind === 'topup' ? { kind: 'topup', amountMinor: 20_000 } : { kind: 'package', packageId: 'growth' });
  expect(r.status).toBe(201);
  return instapayRequestDto.parse(await r.json());
};
const upload = async (api: Api, id: string, tag: string) => {
  return (await SELF.fetch(`https://x/api/v1/stores/${api.phoneNumberId.replace('pn-', '')}/wallet/instapay/${id}/proof`, { method: 'PUT', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'image/png' }, body: PNG(tag) })).status;
};
const row = (id: string) => env.DB.prepare('SELECT state, cancelled_at, contested_at, contest_note, decided_by, decided_at FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; cancelled_at: number | null; contested_at: number | null; contest_note: string | null; decided_by: string | null; decided_at: number | null }>();
const order = (id: string) => env.DB.prepare('SELECT state FROM topups WHERE order_id = ?').bind(id).first<{ state: string }>();
const porder = (id: string) => env.DB.prepare('SELECT status FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string }>();
const audited = (action: string, ws: string) => env.DB.prepare('SELECT count(*) AS n FROM billing_audit WHERE action = ? AND workspace_id = ?').bind(action, ws).first<{ n: number }>().then((r) => r!.n);
const wallet = (ws: string) => env.DB.prepare('SELECT count(*) AS n FROM topups WHERE workspace_id = ? AND state = ?').bind(ws, 'paid').first<{ n: number }>().then((r) => r!.n);
const rejected = async (ws: string, tag: string) => {
  const api = await apiFor(ws);
  const r = await create(api);
  expect(await upload(api, r.id, tag)).toBe(200);
  expect(await rejectInstapay(env, { id: r.id, actor: OP1, reason: 'The amount on the receipt is 150' })).toMatchObject({ ok: true });
  return { api, r };
};

describe('cancel: owner withdraws a request that has no proof yet', () => {
  it('moves awaiting_proof to expired with cancelled_at, closes the order, audits, and the list shows it', async () => {
    const ws = W(1);
    const api = await apiFor(ws);
    const t = await create(api);
    const p = await create(api, 'package');
    const res = await api.call('POST', `/wallet/instapay/${t.id}/cancel`);
    expect(res.status).toBe(200);
    expect(instapayRequestDto.parse(await res.json())).toMatchObject({ id: t.id, state: 'expired', cancelledAt: expect.any(Number) });
    expect(await row(t.id)).toMatchObject({ state: 'expired', cancelled_at: expect.any(Number) });
    expect(await order(t.id)).toEqual({ state: 'expired' });
    expect(await audited('instapay_cancelled_by_owner', ws)).toBe(1);
    expect(await porder(p.id)).toEqual({ status: 'pending' }); // the other request is untouched
    const list = await (await api.call('GET', '/wallet/instapay')).json() as { items: { id: string; cancelledAt?: number | null }[] };
    expect(list.items.find((i) => i.id === t.id)!.cancelledAt).toBeTruthy();
    expect(await wallet(ws)).toBe(0);
  });

  it('twice is refused (exactly one change), and a request with a proof cannot be cancelled: a person decides it', async () => {
    const ws = W(2);
    const api = await apiFor(ws);
    const a = await create(api);
    expect((await api.call('POST', `/wallet/instapay/${a.id}/cancel`)).status).toBe(200);
    expect((await api.call('POST', `/wallet/instapay/${a.id}/cancel`)).status).toBe(409);
    expect(await audited('instapay_cancelled_by_owner', ws)).toBe(1);
    const b = await create(api);
    expect(await upload(api, b.id, 'cancel-proof')).toBe(200);
    expect((await api.call('POST', `/wallet/instapay/${b.id}/cancel`)).status).toBe(409);
    expect((await row(b.id))!.state).toBe('under_review');
  });

  it('staff are refused; another store gets a 404 and its request is untouched', async () => {
    const ws = W(3);
    const other = W(4);
    const mine = await apiFor(ws);
    const theirs = await apiFor(other);
    const r = await create(theirs);
    expect((await (await apiFor(ws, 'staff')).call('POST', `/wallet/instapay/${r.id}/cancel`)).status).toBe(403);
    expect((await mine.call('POST', `/wallet/instapay/${r.id}/cancel`)).status).toBe(404);
    expect((await row(r.id))!.state).toBe('awaiting_proof');
    expect((await (await apiFor(other, 'staff')).call('POST', `/wallet/instapay/${r.id}/cancel`)).status).toBe(403);
  });

  it('a revoked session cannot cancel or contest, at the edge (403) and in the function itself', async () => {
    const ws = W(5);
    const api = await apiFor(ws);
    const r = await create(api);
    configureSessionCheck(async () => true);
    expect((await api.call('POST', `/wallet/instapay/${r.id}/cancel`)).status).toBe(403);
    expect(await cancelInstapay(env, { workspaceId: ws, requestId: r.id, sessionId: 's1', userId: 'u' })).toEqual({ ok: false, reason: 'session_revoked' });
    expect(await contestInstapay(env, { workspaceId: ws, requestId: r.id, sessionId: 's1', userId: 'u', note: 'a long enough note' })).toEqual({ ok: false, reason: 'session_revoked' });
    expect((await row(r.id))!.state).toBe('awaiting_proof');
  });

  it('the daily expiry pass leaves a cancelled request exactly as the owner left it', async () => {
    const ws = W(6);
    const api = await apiFor(ws);
    const r = await create(api);
    await api.call('POST', `/wallet/instapay/${r.id}/cancel`);
    const before = await row(r.id);
    await expireInstapay(env, Date.now() + 3 * 86_400_000);
    expect(await row(r.id)).toEqual(before);
    expect(await order(r.id)).toEqual({ state: 'expired' });
  });
});

describe('contest: owner asks for a second look at a rejection, once', () => {
  const note = { note: 'The transfer went through at 14:05, the amount on the receipt is 200 EGP' };

  it('puts the request back under review for a person, reopens its order, audits, shows to the operator with the note, and never confirms or credits', async () => {
    const ws = W(11);
    const { api, r } = await rejected(ws, 'contest-1');
    expect(await order(r.id)).toEqual({ state: 'failed' });
    const res = await api.call('POST', `/wallet/instapay/${r.id}/contest`, note);
    expect(res.status).toBe(200);
    expect(instapayRequestDto.parse(await res.json())).toMatchObject({ state: 'under_review', contestedAt: expect.any(Number) });
    expect(await row(r.id)).toMatchObject({ state: 'under_review', contest_note: note.note, decided_by: null, decided_at: null });
    expect(await order(r.id)).toEqual({ state: 'pending' });
    expect(await audited('instapay_contested_by_owner', ws)).toBe(1);
    expect(await wallet(ws)).toBe(0); // nothing credited by contesting
    const ops = await (await operatorCall(OP1, 'GET', '/instapay?state=under_review')).json() as { items: { id: string; contestedAt: number | null; contestNote: string | null }[] };
    expect(ops.items.find((i) => i.id === r.id)).toMatchObject({ contestedAt: expect.any(Number), contestNote: note.note });
  });

  it('the operator still has to confirm it, with the normal bank-reference rule; the owner cannot confirm their own payment', async () => {
    const ws = W(12);
    const { api, r } = await rejected(ws, 'contest-2');
    await api.call('POST', `/wallet/instapay/${r.id}/contest`, note);
    // the owner has no route that confirms; the operator route refuses without a bank reference and refuses a merchant token
    expect((await api.call('POST', `/wallet/instapay/${r.id}/confirm`, {})).status).toBe(404);
    expect((await operatorCall(null, 'POST', `/instapay/${r.id}/confirm`, { bankRef: 'BK-1' })).status).toBe(401);
    expect(await confirmInstapay(env, { id: r.id, actor: OP1 })).toEqual({ ok: false, reason: 'bank_reference_required' });
    expect(await confirmInstapay(env, { id: r.id, actor: OP2, bankRef: 'BK-CONTEST-1' })).toMatchObject({ ok: true });
    expect((await row(r.id))!.state).toBe('confirmed');
  });

  it('only once; a second contest is refused and the request stays where the person put it', async () => {
    const ws = W(13);
    const { api, r } = await rejected(ws, 'contest-3');
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(200);
    expect(await rejectInstapay(env, { id: r.id, actor: OP2, reason: 'Still not the right amount' })).toMatchObject({ ok: true });
    const again = await api.call('POST', `/wallet/instapay/${r.id}/contest`, note);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ message: 'already_contested' });
    expect((await row(r.id))!.state).toBe('rejected');
    expect(await audited('instapay_contested_by_owner', ws)).toBe(1);
  });

  it('refuses a request that is not rejected, a bad note (Zod), and a rejection older than the window', async () => {
    const ws = W(14);
    const { api, r } = await rejected(ws, 'contest-4');
    const fresh = await create(api);
    expect((await api.call('POST', `/wallet/instapay/${fresh.id}/contest`, note)).status).toBe(409);
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, { note: 'no' })).status).toBe(400);
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, { note: 'x'.repeat(501) })).status).toBe(400);
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, { ...note, state: 'confirmed' })).status).toBe(400);
    await env.DB.prepare('UPDATE instapay_requests SET decided_at = ? WHERE id = ?').bind(Date.now() - CONTEST_WINDOW_MS - 1000, r.id).run();
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(409);
    expect((await row(r.id))!.state).toBe('rejected');
  });

  it('staff are refused; another store gets a 404; the other store request stays rejected', async () => {
    const ws = W(15);
    const { r } = await rejected(ws, 'contest-5');
    const other = W(16);
    const attacker = await apiFor(other);
    expect((await (await apiFor(ws, 'staff')).call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(403);
    expect((await attacker.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(404);
    expect((await row(r.id))!.state).toBe('rejected');
  });

  it('a system (auto-confirm) decision and a full queue cannot be contested into review', async () => {
    const ws = W(17);
    const { api, r } = await rejected(ws, 'contest-6');
    await env.DB.prepare("UPDATE instapay_requests SET decided_by = 'system:auto-confirm' WHERE id = ?").bind(r.id).run();
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(409);
    await env.DB.prepare("UPDATE instapay_requests SET decided_by = ? WHERE id = ?").bind(OP1, r.id).run();
    for (let i = 0; i < 5; i++) await create(api); // the queue cap is the creation cap
    const full = await api.call('POST', `/wallet/instapay/${r.id}/contest`, note);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ message: 'too_many_open' });
    expect((await row(r.id))!.state).toBe('rejected');
  });
});

describe('contest vs the auto-confirm machine (live mode)', () => {
  beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); await seedGold(); await setMode('off'); });
  afterEach(() => setMode('off'));

  it('a request a person rejected and the owner contested is never confirmed by the machine, neither by a direct attempt nor by the sweep, even with a perfect receipt', async () => {
    const ws = W(19);
    await seedSub(ws);
    const e = aiEnv(goodAnswer(20_000));
    const r = await request(ws, 'topup', { e }); // mode off: waits for a person
    expect(await rejectInstapay(env, { id: r.id, actor: OP1, reason: 'The amount on the receipt is 150' })).toMatchObject({ ok: true });
    const api = await apiFor(ws);
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, { note: 'The transfer went through, receipt attached' })).status).toBe(200);
    await setMode('live');
    await env.DB.prepare('UPDATE instapay_requests SET proof_at = ? WHERE id = ?').bind(Date.now() - 11 * 60_000, r.id).run();
    await autoConfirmInstapay(e, r.id);
    expect(await sweepAutoConfirm(e, Date.now())).toEqual({ decided: 0, completed: 0 });
    expect(aiCalls(e)).toBe(0); // the machine never even read the receipt
    expect(await reqRow(r.id)).toMatchObject({ state: 'under_review' });
    expect(await autoRow(r.id)).not.toMatchObject({ state: 'auto_confirmed' });
  });
});

describe('contest guards (security review of #161)', () => {
  const note = { note: 'The transfer went through at 14:05, the amount on the receipt is 200 EGP' };
  const held = (id: string) => env.DB.prepare('SELECT state, held_reason, held_of, held_at FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; held_reason: string | null; held_of: string | null; held_at: number | null }>();

  it.each([
    ['reverted_at is set', "UPDATE instapay_requests SET reverted_at = 1 WHERE id = ?"],
    ['granted_at is set', "UPDATE instapay_requests SET granted_at = 1 WHERE id = ?"],
    ['decided_by is a system:* value other than auto-confirm', "UPDATE instapay_requests SET decided_by = 'system:revert' WHERE id = ?"],
  ])('refuses to contest when %s (409, still rejected, nothing reopened)', async (_n, sql) => {
    const ws = W(30 + ['reverted_at is set', 'granted_at is set'].indexOf(_n) + (_n.startsWith('decided_by') ? 3 : 0));
    const { api, r } = await rejected(ws, `guard-${_n}`);
    await env.DB.prepare(sql).bind(r.id).run();
    const res = await api.call('POST', `/wallet/instapay/${r.id}/contest`, note);
    expect(res.status).toBe(409);
    expect((await row(r.id))!.state).toBe('rejected');
    expect(await order(r.id)).toEqual({ state: 'failed' });
    expect(await audited('instapay_contested_by_owner', ws)).toBe(0);
  });

  it('keeps an existing hold (held_reason / held_of / held_at) across a contest', async () => {
    const ws = W(1101);
    const { api, r } = await rejected(ws, 'keep-hold');
    await env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_image', held_of = 'other-id', held_at = 123 WHERE id = ?").bind(r.id).run();
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(200);
    expect(await held(r.id)).toEqual({ state: 'under_review', held_reason: 'duplicate_image', held_of: 'other-id', held_at: 123 });
  });

  it('re-runs the duplicate-image check: the same receipt now on another live request holds BOTH, with an audit row', async () => {
    const ws = W(1102);
    const { api, r } = await rejected(ws, 'same-receipt');
    const otherApi = await apiFor(W(1103));
    const b = await create(otherApi);
    expect(await upload(otherApi, b.id, 'same-receipt')).toBe(200); // r is rejected, so b is not held at upload
    expect((await held(b.id))!.held_reason).toBeNull();
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(200);
    expect(await held(r.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_image', held_of: b.id });
    expect((await held(b.id))!.held_reason).toBe('duplicate_image');
    expect(await audited('instapay_held', ws)).toBe(1);
  });

  it('re-runs the duplicate bank-reference check: a reference already on another live request holds the contested one', async () => {
    const ws = W(1104);
    const { api, r } = await rejected(ws, 'ref-dup-a');
    const otherApi = await apiFor(W(1105));
    const c = await create(otherApi);
    expect(await upload(otherApi, c.id, 'ref-dup-c')).toBe(200);
    await env.DB.prepare("UPDATE instapay_requests SET pending_bank_ref = 'BK-DUP-1' WHERE id = ?").bind(c.id).run();
    await env.DB.prepare("UPDATE instapay_requests SET pending_bank_ref = 'BK-DUP-1' WHERE id = ?").bind(r.id).run();
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(200);
    expect(await held(r.id)).toMatchObject({ state: 'under_review', held_reason: 'duplicate_reference', held_of: c.id });
  });

  it('records the original rejection in the audit row and shows the reviewer why it was rejected', async () => {
    const ws = W(1106);
    const { api, r } = await rejected(ws, 'audit-orig');
    expect((await api.call('POST', `/wallet/instapay/${r.id}/contest`, note)).status).toBe(200);
    const a = await env.DB.prepare("SELECT after_json FROM billing_audit WHERE action = 'instapay_contested_by_owner' AND workspace_id = ?").bind(ws).first<{ after_json: string }>();
    expect(JSON.parse(a!.after_json).originalRejection).toMatchObject({ rejectReason: 'The amount on the receipt is 150', decidedBy: OP1, decidedAt: expect.any(Number) });
    const ops = await (await operatorCall(OP1, 'GET', '/instapay?state=under_review')).json() as { items: { id: string; rejectReason: string | null; contestedAt: number | null }[] };
    expect(ops.items.find((i) => i.id === r.id)).toMatchObject({ rejectReason: 'The amount on the receipt is 150', contestedAt: expect.any(Number) });
  });
});
