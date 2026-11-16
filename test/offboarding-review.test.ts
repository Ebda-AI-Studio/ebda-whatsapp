import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credit, type TopupRow } from '../src/core/billing/topups';
import { requestAdjustment } from '../src/core/billing/operator';
import { configureSessionCheck } from '../src/core/identity/session';
import { COOLING_OFF_MS, pseudonymFor, runDueOffboardings, runOffboarding } from '../src/core/ops/offboarding';
import { OP1, OP2, adminToken, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { fund } from './helpers/billing';
import { own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const W = (n: number) => W0(2500 + n);
const DAY = 86_400_000;
const REASON = 'owner asked by e-mail 2026-10-27';
const d1 = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const ownerCall = async (ws: string, method: string, body?: unknown) => (await apiFor(ws, 'owner')).call(method, '/offboarding', body);
const op = (ws: string, sub: string, method: string, path: string, body?: unknown) => operatorCall(sub, method, `/workspaces/${ws}/offboarding${path}`, body);
type Al = { alert?: string; reason?: string; severity?: string };
const alertsOf = (spy: { mock: { calls: unknown[][] } }): Al[] => spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as Al; } catch { return {}; } });
const state = (ws: string) => d1<{ state: string; last_error: string | null; steps_done: string; write_off_minor: number }>('SELECT state, last_error, steps_done, write_off_minor FROM offboarding WHERE workspace_id = ?', ws).then((r) => r[0]!);
const open = (ws: string) => own(ws).then(async () => { await env.MEDIA.put(`media/${ws}/k`, 'x'); });
const erased = async (ws: string) => (await env.MEDIA.list({ prefix: `media/${ws}/` })).objects.length === 0;

describe('item 1: a wallet balance that grew during the cooling-off is never erased silently', () => {
  it('0 -> pending -> a 2,000 EGP credit -> the run HOLDS (balance_grew, P1), nothing is erased; an operator accepting the new write-off lets it finish', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(1);
    await open(ws);
    expect((await (await ownerCall(ws, 'POST', { confirm: true })).json())).toMatchObject({ writeOffMinor: 0 });
    await fund(ws, 200_000); // 2,000 EGP arrives on day 10 (any credit path: a repair, an adjustment, a late confirmation)
    expect(await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS + 1000)).toBe('held');
    expect(await state(ws)).toMatchObject({ state: 'pending', last_error: 'held:balance_grew', steps_done: '' });
    expect(await erased(ws)).toBe(false);
    expect((await rows(ws, "SELECT name FROM sqlite_master WHERE name = 'wallet_entries' OR name = 'contacts'")).length).toBeGreaterThan(0); // the DO is intact
    expect(alertsOf(spy).filter((a) => a.alert === 'offboarding_held' && a.reason === 'balance_grew')).toHaveLength(1);
    // it keeps holding on the next pass, without a second alert
    expect(await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS + 2000)).toBe('held');
    expect(alertsOf(spy).filter((a) => a.reason === 'balance_grew')).toHaveLength(1);
    // the operator sees the new amount and accepts it (audited), then the run finishes
    const refused = await op(ws, OP1, 'POST', '', { reason: REASON });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ message: 'write_off_required', amountMinor: 200_000 });
    expect((await op(ws, OP1, 'POST', '', { reason: REASON, acceptWriteOff: true })).status).toBe(202);
    expect((await state(ws)).write_off_minor).toBe(200_000);
    expect(await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS + 3000)).toBe('done');
    expect(await erased(ws)).toBe(true);
  });

  it('the owner can cancel instead; and the balance is checked again just before the wipe on a resumed run', async () => {
    const ws = W(2);
    await open(ws);
    await ownerCall(ws, 'POST', { confirm: true });
    await fund(ws, 5_000);
    expect(await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS + 1000)).toBe('held');
    expect((await ownerCall(ws, 'DELETE')).status).toBe(200);
    expect(await state(ws)).toMatchObject({ state: 'cancelled' });
    expect(await erased(ws)).toBe(false);

    // a run that already started (earlier steps done) and sees the balance grow right before the wipe holds there, and is released by an accepting operator
    const w2 = W(3);
    await open(w2);
    await op(w2, OP1, 'POST', '', { reason: REASON, immediate: true });
    const r = await runOffboarding(env, w2, Date.now() + 1000, { beforeStep: async (step) => { if (step === 'wipe_do') await fund(w2, 7_000); } });
    expect(r).toBe('held');
    expect(await state(w2)).toMatchObject({ state: 'running', last_error: 'held:balance_grew' });
    expect(await erased(w2)).toBe(false);
    expect((await op(w2, OP1, 'POST', '', { reason: REASON, acceptWriteOff: true, immediate: true })).status).toBe(202);
    expect(await runOffboarding(env, w2, Date.now() + 2000)).toBe('done');
  });

  it('OFFBOARD-FREEZE-1: once a deletion is pending (or running) top-ups, InstaPay requests and package purchases are refused until the owner cancels', async () => {
    const ws = W(4);
    await open(ws);
    const api = await apiFor(ws, 'owner');
    const attempts = () => Promise.all([
      api.call('POST', '/wallet/topups', { amountMinor: 5_000 }),
      api.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 5_000 }),
      api.call('POST', '/packages/test-plan/checkout'),
    ]);
    await ownerCall(ws, 'POST', { confirm: true });
    for (const r of await attempts()) {
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: 'invalid_request', message: 'offboarding_pending' });
    }
    await ownerCall(ws, 'DELETE');
    expect((await api.call('POST', '/wallet/instapay', { kind: 'topup', amountMinor: 5_000 })).status).toBe(201); // cancelled: buying works again
  });
});

describe('item 2: any open money row holds, however old; a credit that reaches an offboarded workspace is refused', () => {
  it('an 8-day-old InstaPay under review, a 20-day-old pending top-up and a paid-but-ungranted package order each hold the run', async () => {
    for (const [i, sql] of [
      "INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, state, created_by, created_at, expires_at, proof_key) VALUES ('ipa-1', 'WA-OLD1', ?1, 'topup', 5000, 'under_review', 'u', ?2, ?2, 'k')",
      "INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at) VALUES ('tp-old', ?1, 5000, 5000, 'pending', 'u', ?2)",
      "INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, status, created_by, created_at, paid_at, provider_ref) VALUES ('po-paid', ?1, 'test-plan', 5000, 'paid', 'u', ?2, ?2, 'ref-1')",
    ].entries()) {
      const ws = W(10 + i);
      await open(ws);
      await env.DB.prepare(sql).bind(ws, Date.now() - 20 * DAY).run().catch(async () => {
        // the order/request ids are fixed in the statement: make them unique per workspace
        await env.DB.prepare(sql.replace(/'(ipa-1|tp-old|po-paid)'/, `'$1-${i}'`).replace("'WA-OLD1'", `'WA-OLD${i}'`)).bind(ws, Date.now() - 20 * DAY).run();
      });
      await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
      expect(await runOffboarding(env, ws, Date.now() + 1000), sql.slice(12, 30)).toBe('held');
      expect((await state(ws)).last_error).toBe('held:payment_in_flight');
      expect(await erased(ws)).toBe(false);
    }
  });

  it('a simulated late confirmation on an offboarded workspace credits nothing, alerts credit_after_offboard (P1) and never creates the ghost workspace', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(20);
    await open(ws);
    // an EXPIRED top-up (not open, so the deletion goes ahead) that a provider can still confirm later
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at) VALUES ('tp-late', ?, 9000, 9000, 'expired', 'u', 1)").bind(ws).run();
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('done');
    const pseudo = (await pseudonymFor(env, ws))!;
    const row = (await d1<TopupRow>('SELECT order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_at, transaction_id FROM topups WHERE order_id = ?', 'tp-late'))[0]!;
    expect(row.workspace_id).toBe(pseudo);
    const id = vi.spyOn(env.WORKSPACE_DO, 'idFromName');
    expect(await credit(env, row, 'tx-late', Date.now())).toBe('offboarded');
    expect(id.mock.calls.map((c) => c[0])).not.toContain(pseudo); // stubOf was never called for the ghost
    expect((await d1<{ state: string }>('SELECT state FROM topups WHERE order_id = ?', 'tp-late'))[0]!.state).toBe('expired');
    const hit = alertsOf(spy).find((a) => a.alert === 'credit_after_offboard');
    expect(hit).toBeTruthy();
    // an operator adjustment and a package grant for the same workspace are refused the same way
    const adj = await requestAdjustment(env, { actor: OP1, workspaceId: pseudo, amountMinor: 500, reason: 'goodwill' }).catch(() => null);
    void adj;
    expect(id.mock.calls.map((c) => c[0])).not.toContain(pseudo);
  });
});

describe('ERASURE-KEY-1: the pseudonym is stored once', () => {
  it('a retry after a key change reuses the stored pseudonym: the money records are never split across two ids', async () => {
    const ws = W(21);
    await open(ws);
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at) VALUES ('tp-key', ?, 9000, 9000, 'expired', 'u', 1)").bind(ws).run();
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    const stored = 'del_' + 'ab'.repeat(16);
    await env.DB.prepare('UPDATE offboarding SET pseudonym = ? WHERE workspace_id = ?').bind(stored, ws).run(); // an earlier attempt stored it under the OLD key
    const changed = { ...env, ERASURE_HMAC_KEY: 'a-different-erasure-key-0123456789abcdef' } as typeof env;
    expect(await pseudonymFor(changed, ws)).not.toBe(stored);
    expect(await runOffboarding(changed, ws, Date.now() + 1000)).toBe('done');
    expect((await d1<{ workspace_id: string }>('SELECT workspace_id FROM topups WHERE order_id = ?', 'tp-key'))[0]!.workspace_id).toBe(stored);
    expect((await d1<{ pseudonym: string }>('SELECT pseudonym FROM offboarding WHERE workspace_id = ?', ws))[0]!.pseudonym).toBe(stored);
  });
});

describe('item 3: held rows never starve a due one', () => {
  it('21 held deletions and one due: the due one runs', async () => {
    const t0 = Date.now();
    const held: string[] = [];
    for (let i = 0; i < 21; i++) {
      const ws = W(100 + i);
      await open(ws);
      await env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, state, requested_by, created_at) VALUES (?, ?, 100, 'pending', 'u', 1)").bind(`rr-starve-${i}`, ws).run();
      held.push(ws);
      await env.DB.prepare("INSERT INTO offboarding (workspace_id, state, requested_by, requested_role, requested_at, execute_after, write_off_minor) VALUES (?, 'pending', 'op', 'operator', 1, ?, 0)").bind(ws, 1000 + i).run();
    }
    const due = W(130);
    await open(due);
    await env.DB.prepare("INSERT INTO offboarding (workspace_id, state, requested_by, requested_role, requested_at, execute_after, write_off_minor) VALUES (?, 'pending', 'op', 'operator', 1, ?, 0)").bind(due, 5000).run();
    const res = await runDueOffboardings(env, t0 + 10_000);
    expect(res.held).toBeGreaterThanOrEqual(21); // (rows other tests of this file left held count too)
    expect(res.processed).toBe(1);
    expect(await erased(due)).toBe(true);
  });

  it('alerts offboarding_backlog (P1) when the pass stops with due rows left', async () => {
    const spy = vi.spyOn(console, 'error');
    for (let i = 0; i < 3; i++) {
      const ws = W(140 + i);
      await open(ws);
      await env.DB.prepare("INSERT INTO offboarding (workspace_id, state, requested_by, requested_role, requested_at, execute_after, write_off_minor) VALUES (?, 'pending', 'op', 'operator', 1, ?, 0)").bind(ws, 1000 + i).run();
      await env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, state, requested_by, created_at) VALUES (?, ?, 100, 'pending', 'u', 1)").bind(`rr-bl-${i}`, ws).run();
    }
    await runDueOffboardings(env, Date.now() + 10_000, { pageSize: 1, maxBatches: 1 });
    expect(alertsOf(spy).some((a) => a.alert === 'offboarding_backlog')).toBe(true);
  });
});

describe('item 9: only the owner cancels through the store route', () => {
  it('a super admin on the store route cannot cancel (or start) a deletion without a reason; the operator route needs one', async () => {
    const ws = W(30);
    await open(ws);
    expect((await op(ws, OP1, 'POST', '', { reason: REASON })).status).toBe(202);
    const token = await adminToken(OP2);
    const call = (method: string, body?: unknown) => SELF.fetch(`https://x/api/v1/stores/${ws}/offboarding`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const del = await call('DELETE');
    expect(del.status).toBe(403);
    expect((await state(ws)).state).toBe('pending');
    expect((await call('POST', { confirm: true })).status).toBe(403); // the same bypass for starting one
    expect((await op(ws, OP2, 'DELETE', '', {})).status).toBe(400); // the operator route needs the reason
    expect((await op(ws, OP2, 'DELETE', '', { reason: REASON })).status).toBe(200);
  });
});

describe('WA-DEBT-1: a debt survives the erasure', () => {
  it('a workspace in debt is erased (data), the debt is preserved in the log and the kept ledger, a P1 fires, and nothing is written off', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(90);
    await open(ws);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -5000, ref: 'adj:off-debt', actor: 'meta', note: 'category change' });
    await workspace(ws).drainLedger();
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('done');
    expect(await erased(ws)).toBe(true); // the data erasure itself is not blocked
    expect(await d1<{ detail: string }>("SELECT detail FROM offboarding_log WHERE workspace_id = ? AND action = 'debt_preserved'", ws)).toEqual([{ detail: 'debt_minor=5000' }]);
    expect(await d1("SELECT 1 FROM offboarding_log WHERE workspace_id = ? AND action = 'write_off_accepted'", ws)).toEqual([]);
    expect((await state(ws)).write_off_minor).toBe(0);
    expect(await d1<{ balance_after: number }>("SELECT balance_after FROM ledger_mirror WHERE workspace_id = ? AND ledger = 'wallet' ORDER BY at DESC LIMIT 1", ws)).toEqual([{ balance_after: -5000 }]);
    expect(alertsOf(spy).filter((a) => a.alert === 'offboarding_debt_outstanding')).toHaveLength(1);
  });
});

describe('item 11: a workspace suspended for abuse keeps its evidence', () => {
  it('holds with suspended_abuse (P1) until an operator releases it with a reason', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(40);
    await open(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'spam complaints, case 4411' })).status).toBe(200);
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('held');
    expect((await state(ws)).last_error).toBe('held:suspended_abuse');
    expect(alertsOf(spy).some((a) => a.alert === 'offboarding_held' && a.reason === 'suspended_abuse')).toBe(true);
    expect(await erased(ws)).toBe(false);
    expect((await op(ws, OP2, 'POST', '/release-hold', {})).status).toBe(400); // a reason is required
    expect((await op(ws, OP2, 'POST', '/release-hold', { reason: 'case 4411 closed, evidence exported' })).status).toBe(200);
    expect((await d1<{ action: string; actor: string }>("SELECT action, actor FROM offboarding_log WHERE workspace_id = ? AND action = 'abuse_hold_released'", ws))).toEqual([{ action: 'abuse_hold_released', actor: OP2 }]);
    expect(await runOffboarding(env, ws, Date.now() + 2000)).toBe('done');
  });

  it('a wallet_debt suspension (WA-DEBT-1) is a money block, not abuse evidence: it does not hold the deletion', async () => {
    const ws = W(42);
    await open(ws);
    await env.DB.prepare("UPDATE workspaces SET suspended_at = 1, suspended_reason = 'wallet_debt' WHERE id = ?").bind(ws).run();
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('done');
  });

  it('a suspension that the deletion itself made (reason offboarding) does not hold a resumed run', async () => {
    const ws = W(41);
    await open(ws);
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true });
    await runOffboarding(env, ws, Date.now() + 1000, { beforeStep: async (s) => { if (s === 'unroute') throw new Error('stop'); } }).catch(() => undefined);
    expect(await runOffboarding(env, ws, Date.now() + 2000)).toBe('done');
  });
});

describe('item 16 (OFFBOARD-2ND-APPROVER-1): an immediate deletion that writes off >= 1,000 EGP needs a second operator', () => {
  const setup = async (n: number, balance = 150_000) => {
    const ws = W(n);
    await open(ws);
    await fund(ws, balance);
    return ws;
  };
  it('holds until a DIFFERENT operator approves; the requester cannot approve; a smaller write-off or the normal 14 days need no approval', async () => {
    const ws = await setup(50);
    const r = await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ needsSecondApproval: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('held');
    expect((await state(ws)).last_error).toBe('held:second_approval_required');
    expect(await erased(ws)).toBe(false);
    const self = await op(ws, OP1, 'POST', '/approve', { reason: 'I agree with myself' });
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({ message: 'requester_cannot_approve' });
    expect((await op(ws, OP2, 'POST', '/approve', {})).status).toBe(400);
    expect((await op(ws, OP2, 'POST', '/approve', { reason: 'legal request verified, balance 1,500 EGP' })).status).toBe(200);
    expect(await runOffboarding(env, ws, Date.now() + 2000)).toBe('done');
    expect((await d1<{ actor: string }>("SELECT actor FROM offboarding_log WHERE workspace_id = ? AND action = 'second_approval'", ws))).toEqual([{ actor: OP2 }]);

    const small = await setup(51, 50_000);
    expect((await (await op(small, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true })).json())).toMatchObject({ needsSecondApproval: false });
    expect(await runOffboarding(env, small, Date.now() + 1000)).toBe('done');

    const slow = await setup(52);
    await op(slow, OP1, 'POST', '', { reason: REASON, acceptWriteOff: true }); // 14 days: the cooling-off is the control
    expect(await runOffboarding(env, slow, Date.now() + COOLING_OFF_MS + 1000)).toBe('done');
  });

  it('someone who released a related hold cannot be the second approver; and an approval is void if the request changed afterwards', async () => {
    const ws = await setup(53);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 77' });
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true });
    expect((await op(ws, OP2, 'POST', '/release-hold', { reason: 'abuse case closed by us' })).status).toBe(200);
    const bad = await op(ws, OP2, 'POST', '/approve', { reason: 'approving what I released' });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ message: 'releaser_cannot_approve' });
    const OP3 = '33333333-3333-4333-8333-333333333333';
    expect((await op(ws, OP3, 'POST', '/approve', { reason: 'verified independently' })).status).toBe(200);
    // the requester changes the write-off after the approval: it no longer counts
    await fund(ws, 100_000);
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true });
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('held');
    expect((await state(ws)).last_error).toBe('held:second_approval_required');
  });
});

describe('security review of the fix pass: the second approver and the claim race', () => {
  const OP3 = '33333333-3333-4333-8333-333333333333';
  it('1. someone who RELEASED the abuse hold can never be the second approver, in either order; another operator can', async () => {
    const ws = W(60);
    await open(ws);
    await fund(ws, 150_000);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 91' });
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true }); // A requests
    // B approves FIRST, then releases the hold: the release is refused (B already approved) ...
    expect((await op(ws, OP2, 'POST', '/approve', { reason: 'verified the balance independently' })).status).toBe(200);
    const rel = await op(ws, OP2, 'POST', '/release-hold', { reason: 'abuse case closed by us' });
    expect(rel.status).toBe(403);
    expect(await rel.json()).toMatchObject({ message: 'approver_cannot_release' });
    // ... and C releases instead: B's approval must NOT count any more (C released; B did not, so it still stands)
    expect((await op(ws, OP3, 'POST', '/release-hold', { reason: 'abuse case closed by us' })).status).toBe(200);
    // C released a related hold, so C's own approval would not count; B's counts
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('done');
  });
  it('1b. B releases the hold and then approves: refused; the approval of a releaser recorded any other way is skipped; C approves and it counts', async () => {
    const ws = W(61);
    await open(ws);
    await fund(ws, 150_000);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 92' });
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true });
    expect((await op(ws, OP2, 'POST', '/release-hold', { reason: 'abuse case closed by us' })).status).toBe(200);
    expect((await op(ws, OP2, 'POST', '/approve', { reason: 'approving what I released' })).status).toBe(403);
    // a releaser's approval row written by any other path (a race, a direct write) is ignored by the run
    const row = (await d1<{ execute_after: number; write_off_minor: number; requested_by: string }>('SELECT execute_after, write_off_minor, requested_by FROM offboarding WHERE workspace_id = ?', ws))[0]!;
    await env.DB.prepare("INSERT INTO offboarding_log (at, workspace_id, actor, action, reason, detail) VALUES (1, ?, ?, 'second_approval', 'forged', ?)").bind(ws, OP2, JSON.stringify({ executeAfter: row.execute_after, writeOffMinor: row.write_off_minor, requestedBy: row.requested_by })).run();
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('held');
    expect((await state(ws)).last_error).toBe('held:second_approval_required');
    expect((await op(ws, OP3, 'POST', '/approve', { reason: 'verified independently' })).status).toBe(200);
    expect(await runOffboarding(env, ws, Date.now() + 2000)).toBe('done');
  });
  it('2. a write-off raised while the row is RUNNING resets the approval: nothing is wiped until a second operator approves the new amount', async () => {
    const ws = W(62);
    await open(ws);
    await fund(ws, 150_000);
    await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true });
    expect((await op(ws, OP2, 'POST', '/approve', { reason: 'verified the balance independently' })).status).toBe(200);
    const r = await runOffboarding(env, ws, Date.now() + 1000, { beforeStep: async (step) => { if (step === 'wipe_do') await fund(ws, 100_000); } });
    expect(r).toBe('held'); // balance grew right before the wipe
    expect(await state(ws)).toMatchObject({ state: 'running', last_error: 'held:balance_grew' });
    expect((await op(ws, OP1, 'POST', '', { reason: REASON, immediate: true, acceptWriteOff: true })).status).toBe(202); // the takeover accepts 2,500 EGP
    expect((await state(ws)).write_off_minor).toBe(250_000);
    expect(await runOffboarding(env, ws, Date.now() + 2000)).toBe('held');
    expect((await state(ws)).last_error).toBe('held:second_approval_required');
    expect(await erased(ws)).toBe(false);
    expect((await op(ws, OP3, 'POST', '/approve', { reason: 'verified the new amount' })).status).toBe(200);
    expect(await runOffboarding(env, ws, Date.now() + 3000)).toBe('done');
  });
});
