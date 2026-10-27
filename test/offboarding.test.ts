import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { COOLING_OFF_MS, OFFBOARD_TABLES, pseudonymFor, runDueOffboardings, runOffboarding } from '../src/core/ops/offboarding';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { fund } from './helpers/billing';
import { openChat, own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const DAY = 86_400_000;
const REASON = 'owner asked by e-mail 2026-10-27';
const d1 = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const ownerCall = async (ws: string, method: string, body?: unknown, role: 'owner' | 'staff' = 'owner') => (await apiFor(ws, role)).call(method, '/offboarding', body);

/** A workspace with data in every place deletion has to reach: the DO, every R2 prefix, and the D1 tables (money and not money). */
async function populate(ws: string): Promise<string> {
  const pn = `pn-${ws.slice(-8)}`;
  await own(ws, pn);
  await openChat(ws, '201001234567', { text: 'x'.repeat(2000) }); // > 1 KB: the body goes to R2
  await openChat(ws, '201007654321');
  const keys = [`media/${ws}/wamid.1`, `uploads/${ws}/u1`, `imports/${ws}/i1.csv`, `instapay-proof/${ws}/p1.jpg`];
  for (const k of keys) await env.MEDIA.put(k, 'data');
  await env.MEDIA.put(`media/${ws}-other/keep`, 'not ours'); // a prefix-sharing neighbour must survive
  await env.BACKUPS.put(`backups/${ws}/2026-10-26/manifest.json`, '{}');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at) VALUES (?, ?, 'enc', 'own', 1, 1)").bind(`waba-${ws}`, ws),
    env.DB.prepare('INSERT OR IGNORE INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, ?, NULL, 1)').bind('pn-platform', 'waba-platform'),
    env.DB.prepare("INSERT INTO shared_number_members (workspace_id, phone_number_id, display_name, status, joined_at) VALUES (?, 'pn-platform', 'متجر', 'active', 1)").bind(ws),
    env.DB.prepare("INSERT INTO shared_routes (phone_number_id, customer_key, workspace_id, last_at) VALUES ('pn-platform', 'ck1', ?, 1)").bind(ws),
    env.DB.prepare("INSERT INTO shared_sent (wamid, workspace_id, customer_key, at) VALUES (?, ?, 'ck1', 1)").bind(`wamid.sent.${ws}`, ws),
    env.DB.prepare("INSERT INTO workspace_subscriptions (workspace_id, package_id, status, period_start, period_end, version, updated_at) VALUES (?, 'test-plan', 'active', 0, ?, 1, 1)").bind(ws, now + DAY),
    env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at, paid_at) VALUES (?, ?, 10000, 10000, 'paid', 'user-merchant', 1, 2)").bind(`top-${ws}`, ws),
    env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, status, created_by, created_at, paid_at) VALUES (?, ?, 'test-plan', 50000, 'paid', 'user-merchant', 1, 2)").bind(`ord-${ws}`, ws),
    env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, package_id, amount_minor, state, created_by, created_at, expires_at, proof_key, proof_mime, proof_bytes, proof_at, decided_by, decided_at) VALUES (?, ?, ?, 'package', 'test-plan', 50000, 'confirmed', 'user-merchant', 1, 2, ?, 'image/jpeg', 4, 1, 'op-1', 2)").bind(`ip-${ws}`, `REF-${ws.slice(-6)}`, ws, `instapay-proof/${ws}/p1.jpg`),
    env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, note, state, requested_by, created_at) VALUES (?, ?, 5000, 'my iban is …', 'paid', 'user-merchant', 1)").bind(`rr-${ws}`, ws),
    env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at, note) VALUES (?, ?, ?, ?, 5000, 'api', 'succeeded', 1, 1, 'free text')").bind(`cr-${ws}`, `rr-${ws}`, `top-${ws}`, ws),
    env.DB.prepare("INSERT INTO ledger_mirror (workspace_id, ledger, ref, at, kind, amount, balance_after) VALUES (?, 'wallet', 'r1', 1, 'topup', 10000, 10000)").bind(ws),
    env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, reason) VALUES (1, 'op-1', 'adjust', ?, 'x')").bind(ws),
    env.DB.prepare("INSERT INTO operator_actions (at, actor, action, workspace_id, reason) VALUES (1, 'op-1', 'suspend', ?, 'earlier action')").bind(ws),
  ]);
  return pn;
}

describe('requesting, cooling off and cancelling', () => {
  it('only an owner can ask; the request waits 14 days; asking twice changes nothing', async () => {
    const ws = W(2001);
    await own(ws);
    expect((await ownerCall(ws, 'POST', { confirm: true }, 'staff')).status).toBe(403);
    expect((await ownerCall(ws, 'POST', {})).status).toBe(400); // no explicit confirmation
    const before = Date.now();
    const r = await ownerCall(ws, 'POST', { confirm: true });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { state: string; executeAfter: number; requestedBy: string; requestedRole: string };
    expect(body).toMatchObject({ state: 'pending', requestedRole: 'owner' });
    expect(body.executeAfter).toBeGreaterThanOrEqual(before + COOLING_OFF_MS);
    expect(body.executeAfter).toBeLessThan(Date.now() + COOLING_OFF_MS + 1000);
    const again = (await (await ownerCall(ws, 'POST', { confirm: true })).json()) as { executeAfter: number };
    expect(again.executeAfter).toBe(body.executeAfter);
    expect(await (await ownerCall(ws, 'GET')).json()).toMatchObject({ state: 'pending', executeAfter: body.executeAfter });
    expect(await d1('SELECT action, actor FROM offboarding_log WHERE workspace_id = ? ORDER BY id', ws)).toEqual([{ action: 'requested', actor: expect.any(String) }]);
  });

  it('an owner cannot skip the cooling-off; an operator can, with a reason, and it is audited', async () => {
    const ws = W(2002);
    await own(ws);
    expect((await ownerCall(ws, 'POST', { confirm: true, immediate: true })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { immediate: true })).status).toBe(400); // reason required
    const r = await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON, immediate: true });
    expect(r.status).toBe(202);
    const s = (await r.json()) as { executeAfter: number; requestedRole: string };
    expect(s.requestedRole).toBe('operator');
    expect(s.executeAfter).toBeLessThanOrEqual(Date.now());
    expect(await d1('SELECT actor, action, reason FROM offboarding_log WHERE workspace_id = ?', ws)).toEqual([{ actor: OP1, action: 'requested', reason: REASON }]);
    expect((await operatorCall(null, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON })).status).toBe(401);
  });

  it('cancelling during the window leaves everything untouched, and a new request can follow', async () => {
    const ws = W(2003);
    await populate(ws);
    await ownerCall(ws, 'POST', { confirm: true });
    expect((await ownerCall(ws, 'DELETE')).status).toBe(200);
    expect(await (await ownerCall(ws, 'GET')).json()).toMatchObject({ state: 'cancelled' });
    expect((await ownerCall(ws, 'DELETE')).status).toBe(409); // nothing left to cancel
    await runDueOffboardings(env, Date.now() + 30 * DAY);
    expect(await d1('SELECT state FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ state: 'cancelled' }]);
    expect(await d1('SELECT 1 FROM workspaces WHERE id = ?', ws)).toHaveLength(1);
    expect((await ownerCall(ws, 'POST', { confirm: true })).status).toBe(202);
    expect(await d1('SELECT action FROM offboarding_log WHERE workspace_id = ? ORDER BY id', ws)).toEqual([{ action: 'requested' }, { action: 'cancelled' }, { action: 'requested' }]);
  });

  it('a wallet balance has to be given up explicitly (or settled first)', async () => {
    const ws = W(2004);
    await own(ws);
    await fund(ws, 20_000);
    const refused = await ownerCall(ws, 'POST', { confirm: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ message: 'wallet_balance_remains' });
    const ok = await ownerCall(ws, 'POST', { confirm: true, acceptWriteOff: true });
    expect(ok.status).toBe(202);
    expect(await d1('SELECT write_off_minor FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ write_off_minor: 20_000 }]);
  });
});

describe('a cancel can never lose a race with the run (security review: TOCTOU)', () => {
  const untouched = async (ws: string) => {
    expect((await env.MEDIA.list({ prefix: `media/${ws}/` })).objects).toHaveLength(1);
    expect(await d1('SELECT 1 FROM workspaces WHERE id = ?', ws)).toHaveLength(1);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).not.toEqual([]);
  };

  it('a cancel landing between the read and the claim: nothing is claimed, nothing is erased', async () => {
    const ws = W(2020);
    await populate(ws);
    await ownerCall(ws, 'POST', { confirm: true });
    const r = await runOffboarding(env, ws, Date.now() + COOLING_OFF_MS + 1000, { afterRead: async () => { expect((await ownerCall(ws, 'DELETE')).status).toBe(200); } });
    expect(r).toBe('skipped');
    expect(await d1('SELECT state, steps_done, attempts FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ state: 'cancelled', steps_done: '', attempts: 0 }]);
    await untouched(ws);
  });

  it('a row that is not yet due is skipped even when called directly', async () => {
    const ws = W(2021);
    await populate(ws);
    await ownerCall(ws, 'POST', { confirm: true });
    expect(await runOffboarding(env, ws, Date.now() + DAY)).toBe('skipped');
    expect(await d1('SELECT state, attempts FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ state: 'pending', attempts: 0 }]);
    await untouched(ws);
  });

  it('a cancel landing after step 1 stops the run before step 2', async () => {
    const ws = W(2022);
    await populate(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON, immediate: true });
    const seen: string[] = [];
    const r = await runOffboarding(env, ws, Date.now() + 1000, {
      beforeStep: async (step) => {
        seen.push(step);
        if (step === 'unroute') await env.DB.prepare("UPDATE offboarding SET state = 'cancelled' WHERE workspace_id = ?").bind(ws).run(); // a cancel arrives mid-run
      },
    });
    expect(r).toBe('skipped');
    expect(seen).toEqual(['suspend', 'unroute']);
    expect(await d1('SELECT steps_done FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ steps_done: 'suspend' }]);
    await untouched(ws);
    expect(await d1('SELECT 1 FROM phone_numbers WHERE workspace_id = ?', ws)).toHaveLength(1); // step 2 (unroute) did not run
  });
});

describe('who may cancel', () => {
  it('an owner cannot cancel a deletion an operator started: 403, the row is unchanged; the operator can', async () => {
    const ws = W(2023);
    await own(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON });
    const before = await d1('SELECT * FROM offboarding WHERE workspace_id = ?', ws);
    const r = await ownerCall(ws, 'DELETE');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'forbidden', message: 'operator_requested' });
    expect(await d1('SELECT * FROM offboarding WHERE workspace_id = ?', ws)).toEqual(before);
    expect((await operatorCall(OP1, 'DELETE', `/workspaces/${ws}/offboarding`, { reason: REASON })).status).toBe(200);
  });

  it('a suspended workspace may still ask (POST) and read (GET), but not cancel (DELETE)', async () => {
    const ws = W(2024);
    await own(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    expect((await ownerCall(ws, 'POST', { confirm: true })).status).toBe(202);
    expect((await ownerCall(ws, 'GET')).status).toBe(200);
    const del = await ownerCall(ws, 'DELETE');
    expect(del.status).toBe(403);
    expect(await del.json()).toMatchObject({ message: 'workspace_suspended' });
  });
});

describe('the deletion itself', () => {
  it('does nothing before the cooling-off ends; then erases the DO, every R2 prefix, and the D1 rows; keeps pseudonymised money', async () => {
    const ws = W(2010);
    await populate(ws);
    await ownerCall(ws, 'POST', { confirm: true });
    const start = Date.now();
    await runDueOffboardings(env, start + 13 * DAY);
    expect(await d1('SELECT state FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ state: 'pending' }]);
    expect((await env.MEDIA.list({ prefix: `media/${ws}/` })).objects).toHaveLength(1);

    const res = await runDueOffboardings(env, start + COOLING_OFF_MS + 1000);
    expect(res.processed).toBeGreaterThanOrEqual(1);
    const st = (await d1<{ state: string; steps_done: string; pseudonym: string; last_error: string | null; finished_at: number }>('SELECT * FROM offboarding WHERE workspace_id = ?', ws))[0]!;
    expect(st.state, String(st.last_error) + st.steps_done).toBe('done');
    expect(st.last_error).toBeNull();
    const pseudo = (await pseudonymFor(env, ws))!;
    expect(st.pseudonym).toBe(pseudo);
    expect(pseudo).toMatch(/^del_[0-9a-f]{32}$/);
    expect(pseudo).not.toContain(ws);

    // R2: ours gone (all five prefixes + backups), the neighbour with a common prefix stays.
    for (const p of ['bodies', 'media', 'uploads', 'imports', 'instapay-proof']) expect((await env.MEDIA.list({ prefix: `${p}/${ws}/` })).objects).toEqual([]);
    expect((await env.BACKUPS.list({ prefix: `backups/${ws}/` })).objects).toEqual([]);
    expect((await env.MEDIA.list({ prefix: `media/${ws}-other/` })).objects).toHaveLength(1);

    // The DO holds nothing, and says it was deleted.
    const left = await runInDurableObject(workspace(ws), async (_i, state) => ({
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray(),
      tombstone: await state.storage.get('offboarded'),
      alarm: await state.storage.getAlarm(),
    }));
    expect(left.tables).toEqual([]);
    expect(left.tombstone).toBeTruthy();
    expect(left.alarm).toBeNull();

    // D1: nothing left under the real id except the append-only audit; the workspace row is gone.
    expect(await d1('SELECT 1 FROM workspaces WHERE id = ?', ws)).toEqual([]);
    for (const t of ['phone_numbers', 'waba_credentials', 'shared_number_members', 'shared_routes', 'shared_sent', 'workspace_subscriptions', 'topups', 'package_orders', 'instapay_requests', 'refund_requests', 'card_refunds']) {
      expect(await d1(`SELECT 1 FROM ${t} WHERE workspace_id = ?`, ws), t).toEqual([]);
    }
    expect(await d1('SELECT actor FROM operator_actions WHERE workspace_id = ?', ws)).toEqual([{ actor: 'op-1' }]);

    // The money stays, under the pseudonym, amounts unchanged; free text and the proof reference are cleared.
    expect(await d1('SELECT amount_minor, created_by FROM topups WHERE workspace_id = ?', pseudo)).toEqual([{ amount_minor: 10_000, created_by: pseudo }]);
    expect(await d1('SELECT amount_minor FROM package_orders WHERE workspace_id = ?', pseudo)).toEqual([{ amount_minor: 50_000 }]);
    expect(await d1('SELECT amount_minor, proof_key, created_by, decided_by FROM instapay_requests WHERE workspace_id = ?', pseudo)).toEqual([{ amount_minor: 50_000, proof_key: null, created_by: pseudo, decided_by: 'op-1' }]);
    expect(await d1('SELECT note, requested_by FROM refund_requests WHERE workspace_id = ?', pseudo)).toEqual([{ note: null, requested_by: pseudo }]);
    expect(await d1('SELECT note FROM card_refunds WHERE workspace_id = ?', pseudo)).toEqual([{ note: null }]);
    // The immutable ledgers (triggers forbid UPDATE) keep the opaque id.
    expect(await d1('SELECT amount FROM ledger_mirror WHERE workspace_id = ?', ws)).toEqual([{ amount: 10_000 }]);
    expect(await d1('SELECT 1 FROM billing_audit WHERE workspace_id = ?', ws)).toHaveLength(1);

    // Audited, without any phone number or message text.
    const log = await d1<{ action: string; detail: string | null }>('SELECT action, detail FROM offboarding_log WHERE workspace_id = ? ORDER BY id', ws);
    expect(log.map((l) => l.action)).toEqual(['requested', 'started', 'step_done', 'step_done', 'step_done', 'step_done', 'step_done', 'step_done', 'step_done', 'completed']);
    expect(JSON.stringify(log)).not.toMatch(/2010\d{7}/);

    // The deleted store's token is a stranger now, and a second pass is a no-op.
    const logged = (await d1<{ n: number }>('SELECT count(*) AS n FROM offboarding_log WHERE workspace_id = ?', ws))[0]!.n;
    await runDueOffboardings(env, start + 40 * DAY);
    expect((await d1<{ n: number }>('SELECT count(*) AS n FROM offboarding_log WHERE workspace_id = ?', ws))[0]!.n).toBe(logged); // a finished run is a no-op
  });

  it('is resumable: a failing R2 delete leaves the run unfinished (and alerts), the next pass finishes without redoing the first steps', async () => {
    const ws = W(2011);
    await populate(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON, immediate: true });
    const del = vi.spyOn(env.MEDIA, 'delete').mockRejectedValueOnce(new Error('r2 down +201001234567'));
    const first = await runDueOffboardings(env, Date.now() + 1000);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const mid = (await d1<{ state: string; steps_done: string; last_error: string }>('SELECT state, steps_done, last_error FROM offboarding WHERE workspace_id = ?', ws))[0]!;
    expect(mid.state).toBe('running');
    expect(mid.steps_done.split(',')).toContain('wipe_do');
    expect(mid.steps_done.split(',')).not.toContain('d1');
    expect(mid.last_error).not.toMatch(/201001234567/); // class only, never the text
    expect(await d1('SELECT 1 FROM workspaces WHERE id = ?', ws)).toHaveLength(1);
    del.mockRestore();
    const second = await runDueOffboardings(env, Date.now() + 2000);
    expect(second.processed).toBeGreaterThanOrEqual(1);
    expect((await d1<{ state: string; attempts: number }>('SELECT state, attempts FROM offboarding WHERE workspace_id = ?', ws))[0]).toMatchObject({ state: 'done', attempts: 2 });
    expect(await d1('SELECT 1 FROM workspaces WHERE id = ?', ws)).toEqual([]);
    expect(await d1('SELECT count(*) AS n FROM offboarding_log WHERE workspace_id = ? AND action = ?', ws, 'step_done').then((r) => (r[0] as { n: number }).n)).toBe(7);
  });

  it('holds (touches nothing) while money is in flight, and says why', async () => {
    const ws = W(2012);
    await populate(ws);
    await env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, state, requested_by, created_at) VALUES (?, ?, 6000, 'pending', 'u', 1)").bind(`rr-open-${ws}`, ws).run();
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON, immediate: true });
    const r = await runDueOffboardings(env, Date.now() + 1000);
    expect(r.held).toBeGreaterThanOrEqual(1);
    expect((await d1<{ state: string; last_error: string; steps_done: string }>('SELECT state, last_error, steps_done FROM offboarding WHERE workspace_id = ?', ws))[0]).toMatchObject({ last_error: 'held:open_refund', steps_done: '' });
    expect((await env.MEDIA.list({ prefix: `media/${ws}/` })).objects).toHaveLength(1);
    await env.DB.prepare("UPDATE refund_requests SET state = 'rejected' WHERE id = ?").bind(`rr-open-${ws}`).run();
    await runDueOffboardings(env, Date.now() + 2000);
    expect(await d1('SELECT state FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ state: 'done' }]);
  });

  it('after the numbers are unrouted a late webhook finds no workspace', async () => {
    const ws = W(2013);
    const pn = await populate(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/offboarding`, { reason: REASON, immediate: true });
    await runDueOffboardings(env, Date.now() + 1000);
    expect(await d1('SELECT 1 FROM phone_numbers WHERE phone_number_id = ?', pn)).toEqual([]);
    expect(await d1('SELECT 1 FROM number_funding WHERE phone_number_id = ?', pn)).toEqual([]);
  });
});

describe('every D1 table that names a workspace has a deletion decision', () => {
  it('classifies each table with a workspace_id column or a foreign key to workspaces (a new table fails here until someone decides)', async () => {
    const tables = await d1<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'd1_%'");
    const named: string[] = [];
    for (const { name } of tables) {
      const cols = await d1<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`);
      const fks = await d1<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('${name}')`);
      if (cols.some((c) => c.name === 'workspace_id') || fks.some((f) => f.table === 'workspaces')) named.push(name);
    }
    const decided = new Set([...Object.keys(OFFBOARD_TABLES.delete), ...Object.keys(OFFBOARD_TABLES.keep), ...OFFBOARD_TABLES.audit]);
    expect(named.filter((t) => !decided.has(t) && t !== 'workspaces').sort()).toEqual([]);
    // and no decision names a table that does not exist
    expect([...decided].filter((t) => !tables.some((x) => x.name === t)).sort()).toEqual([]);
  });
});
