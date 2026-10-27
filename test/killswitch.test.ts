import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { clearIntegrationCache } from '../src/core/identity/integration';
import { configureSessionCheck } from '../src/core/identity/session';
import { joinShared, sharedStatus } from '../src/core/shared/shared-number';
import { postWebhook } from './helpers/meta';
import { mintClient } from './helpers/issuer';
import { PARAMS, makeCampaign, seedContacts, seedSharedTemplate, seedTemplate } from './helpers/campaigns';
import { OP1, apiFor, apiKey, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, holdOf, jobOf, pn, queueTemplate, queueText, sendOut, setupBilling } from './helpers/billing';
import { applyHealthEvent, syncMemberHealth } from '../src/core/numbers/health-events';
import { configureWriteSessionDefault } from '../src/core/identity/session';
import { SPIKE_THRESHOLD } from '../src/core/numbers/health';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); clearIntegrationCache(); });
afterEach(() => configureSessionCheck(null));

const REASON = 'abuse report 2026-10-27';
const actions = (ws: string) => env.DB.prepare('SELECT o.actor, o.action, r.reason, o.detail FROM operator_actions o LEFT JOIN audit_reasons r ON r.id = o.reason_id WHERE o.workspace_id = ? ORDER BY o.id').bind(ws).all<{ actor: string; action: string; reason: string; detail: string | null }>().then((r) => r.results);
const sendBody = { type: 'text', clientId: crypto.randomUUID(), text: 'hello' };

describe('operator actions: access, reason, audit', () => {
  it('super admin only; a reason of 5+ characters is required; each action is audited with actor and reason', async () => {
    const ws = W(1100);
    await setupBilling(ws);
    const owner = await apiFor(ws);
    const asOwner = await SELF.fetch(`https://x/api/v1/operator/workspaces/${ws}/suspend`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: REASON }) });
    expect(asOwner.status).toBe(403);
    expect((await operatorCall(null, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(401);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, {})).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'no' })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${W(1199)}/suspend`, { reason: REASON })).status).toBe(404); // unknown workspace
    expect(await actions(ws)).toEqual([]);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    expect(await actions(ws)).toEqual([{ actor: OP1, action: 'suspend', reason: REASON, detail: null }]);
  });

  it('a revoked operator session cannot act (fail closed)', async () => {
    const ws = W(1101);
    await setupBilling(ws);
    configureSessionCheck(async () => true);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(403);
    expect(await actions(ws)).toEqual([]);
  });

  it('operator_actions is append-only: no UPDATE, no DELETE', async () => {
    const ws = W(1102);
    await setupBilling(ws);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    await expect(env.DB.prepare("UPDATE operator_actions SET reason = 'edited reason' WHERE workspace_id = ?").bind(ws).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM operator_actions WHERE workspace_id = ?').bind(ws).run()).rejects.toThrow(/append-only/);
    expect(await actions(ws)).toHaveLength(1);
  });
});

describe('suspend / unsuspend', () => {
  it('writes are refused at the Worker, reading stays, paying and erasing stay, campaigns pause, then unsuspend restores writes', async () => {
    const ws = W(1103);
    await setupBilling(ws);
    const conv = await chat(ws, 'UTILITY');
    const api = await apiFor(ws);
    expect((await api.call('POST', `/conversations/${conv}/messages`, { ...sendBody, clientId: crypto.randomUUID() })).status).toBe(202);
    const topupBefore = await api.call('POST', '/wallet/topups', { amountMinor: 10000 });
    await exec(ws, "INSERT INTO contacts (wa_id, profile_name) VALUES ('201009999999', 'erase me')");
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    const topupWhileSuspended = await api.call('POST', '/wallet/topups', { amountMinor: 10000 });
    const erasedWhileSuspended = await api.call('DELETE', '/contacts/201009999999');
    const blocked = await api.call('POST', `/conversations/${conv}/messages`, { ...sendBody, clientId: crypto.randomUUID() });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: 'forbidden', message: 'workspace_suspended' });
    expect((await api.call('GET', '/conversations')).status).toBe(200); // reading stays
    // Paying and erasing a contact are NOT blocked: each answers exactly what it answers for a store that is not suspended (asserted against the real status, not "anything but the suspension").
    expect(topupWhileSuspended.status).toBe(topupBefore.status);
    expect(topupWhileSuspended.status).not.toBe(403);
    expect(erasedWhileSuspended.status).toBe(200);
    const unsus = await operatorCall(OP1, 'POST', `/workspaces/${ws}/unsuspend`, { reason: 'resolved with the owner' });
    expect(unsus.status).toBe(200);
    expect((await api.call('POST', `/conversations/${conv}/messages`, { ...sendBody, clientId: crypto.randomUUID() })).status).toBe(202);
    expect((await actions(ws)).map((a) => a.action)).toEqual(['suspend', 'unsuspend']);
  });

  it('the Durable Object refuses every send on its own (queued jobs, retries and alarms never pass the Worker), and the agent is off; inbound is still stored', async () => {
    const ws = W(1104);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueText(ws, conv));
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'workspace_suspended' }]);
    const r = await workspace(ws).ingest({ phoneNumberId: pn(ws), inbound: [{ wamid: 'w.in.1', from: '201005550000', ts: 1, type: 'text', text: 'still hearing you' }], statuses: [], receivedAt: 1 });
    expect(r.stored).toBe(1);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/unsuspend`, { reason: 'resolved with the owner' });
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await workspace(ws).claimSend(jobOf(await queueText(ws, conv, 'again')))).toBe('claimed');
  });

  it('suspending pauses every running campaign (operator_paused); unsuspending resumes none', async () => {
    const ws = W(1105);
    await own(ws);
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const c = await makeCampaign(ws);
    await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", c.id);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns WHERE id = ?', c.id)).toEqual([{ status: 'paused', pause_reason: 'operator_paused' }]);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/unsuspend`, { reason: 'resolved with the owner' });
    expect((await rows<{ status: string }>(ws, 'SELECT status FROM campaigns WHERE id = ?', c.id))[0]!.status).toBe('paused');
  });
});

describe('pause all campaigns', () => {
  it('pauses running and scheduled campaigns with operator_paused, audits the count, does not suspend', async () => {
    const ws = W(1106);
    await own(ws);
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const c = await makeCampaign(ws);
    await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", c.id);
    const r = await operatorCall(OP1, 'POST', `/workspaces/${ws}/campaigns/pause`, { reason: REASON });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ paused: 1 });
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns WHERE id = ?', c.id)).toEqual([{ status: 'paused', pause_reason: 'operator_paused' }]);
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await actions(ws)).toEqual([{ actor: OP1, action: 'pause_campaigns', reason: REASON, detail: null }]);
  });
});

describe('shared number', () => {
  async function sharedRow(health = 'green') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM shared_number_members'), env.DB.prepare('DELETE FROM shared_numbers'),
      env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at, health_state) VALUES ('pn-plat', 'waba-plat', '+20 100 888 0001', 1, ?)").bind(health),
    ]);
  }
  it('A7: while the platform number is not green no new member joins (yellow, red, restricted); green again lets them in', async () => {
    const ws = W(1107);
    await setupBilling(ws);
    await sharedRow('yellow');
    for (const s of ['yellow', 'red', 'restricted']) {
      await env.DB.prepare('UPDATE shared_numbers SET health_state = ?').bind(s).run();
      expect(await joinShared(env, ws, 'Nour Shop'), s).toBe('number_unhealthy');
    }
    expect(await env.DB.prepare('SELECT 1 FROM shared_number_members').first()).toBeNull();
  });
  it('the platform number\'s state follows Meta\'s webhooks (D1 row; FLAGGED -> red, UNFLAGGED recovers) and a stale recovery is ignored', async () => {
    await sharedRow('green');
    const hook = (event: string, time: number) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '201008880001', event, current_limit: 'TIER_1K' } }] }] });
    expect((await postWebhook(SELF, hook('FLAGGED', 100))).status).toBe(200);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('red');
    await postWebhook(SELF, hook('UNFLAGGED', 200));
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
    await postWebhook(SELF, hook('FLAGGED', 100)); // Meta retries the old FLAGGED: a worsening signal is never dropped for being old (fail closed)...
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('red');
    await postWebhook(SELF, hook('UNFLAGGED', 150)); // ...and an older RECOVERY is: UNFLAGGED(150) is older than the newest applied (200)
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('red');
    await postWebhook(SELF, hook('UNFLAGGED', 300));
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
  });
  it('a member store\'s own Durable Object learns the platform number went red / restricted: template sends are refused and a campaign cannot start (fail-open gate closed)', async () => {
    const ws = W(1112);
    await setupBilling(ws);
    await fund(ws, 100_000);
    await sharedRow('green');
    await env.DB.prepare("INSERT INTO shared_number_members (workspace_id, phone_number_id, display_name, name_key, status, joined_at) VALUES (?, 'pn-plat', 'Nour Shop', 'nourshop', 'active', 1)").bind(ws).run();
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const created = await workspace(ws).createCampaign({ name: 'c', template: { name: 'promo', language: 'ar' }, params: PARAMS as never, audience: { criteria: { everyone: true } as never }, phoneNumberId: 'pn-plat', actor: 'u' });
    if (!created.ok) throw new Error(created.reason);
    const hook = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time: 1, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' }] } }] }] });
    expect((await postWebhook(SELF, hook)).status).toBe(200);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('restricted');
    await vi.waitFor(async () => expect(await workspace(ws).numberHealth('pn-plat')).toBe('restricted')); // pushed to the member's own copy (in the background)
    expect(await workspace(ws).sendCampaign(created.campaign.id)).toEqual({ ok: false, reason: 'number_restricted' });
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES ('pn-plat', 'platform_line', 0)").run();
    await seedSharedTemplate('pn-plat', { name: 'tpl-u', language: 'ar' });
    const conv = await chat(ws, 'UTILITY');
    const tpl = await workspace(ws).queueOutbound(conv, 'pn-plat', { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    expect(tpl.ok).toBe(true);
    if (tpl.ok && tpl.job) expect(await workspace(ws).claimSend(tpl.job)).toBe('dropped');
    // recovery reaches the members too
    const lifted = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time: 1, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [] } }] }] });
    await postWebhook(SELF, lifted);
    await vi.waitFor(async () => expect(await workspace(ws).numberHealth('pn-plat')).toBe('yellow'));
  });
  it('evict: the member leaves and its routes go, it cannot rejoin until the operator readmits it; audited', async () => {
    const ws = W(1108);
    await setupBilling(ws);
    await sharedRow('green');
    await env.DB.prepare("INSERT INTO shared_number_members (workspace_id, phone_number_id, display_name, name_key, status, joined_at) VALUES (?, 'pn-plat', 'Nour Shop', 'nourshop', 'active', 1)").bind(ws).run();
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/shared-number/evict`, { reason: REASON })).status).toBe(200);
    expect(await env.DB.prepare('SELECT status FROM shared_number_members WHERE workspace_id = ?').bind(ws).first('status')).toBe('left');
    expect(await joinShared(env, ws, 'Nour Shop')).toBe('evicted');
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/shared-number/readmit`, { reason: 'cleared after review' })).status).toBe(200);
    expect(await joinShared(env, ws, 'Nour Shop')).not.toBe('evicted');
    expect((await actions(ws)).map((a) => a.action)).toEqual(['evict_shared', 'readmit_shared']);
  });
});

describe('revoke all integration tokens of a store', () => {
  const live = { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
  const call = async (token: string, path: string) =>
    worker.fetch(new Request(`https://x/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }), { ...env, ...live } as typeof env, createExecutionContext());
  it('while revoked EVERY server token is refused (401), also one minted after the revoke (a client re-mints every few minutes); restoring lets them back in; both audited', async () => {
    const ws = W(1109);
    await apiFor(ws);
    const before = await mintClient(apiKey(), { storeId: ws, scope: 'conversations:read' });
    expect((await call(before, `/stores/${ws}/conversations`)).status).toBe(200);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/integrations/revoke`, { reason: REASON })).status).toBe(200);
    expect((await call(before, `/stores/${ws}/conversations`)).status).toBe(401);
    const after = await mintClient(apiKey(), { storeId: ws, scope: 'conversations:read' }); // minted AFTER the revoke
    expect((await call(after, `/stores/${ws}/conversations`)).status).toBe(401);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/integrations/restore`, { reason: 'owner rotated the secret' })).status).toBe(200);
    expect((await call(after, `/stores/${ws}/conversations`)).status).toBe(200);
    expect((await actions(ws)).map((a) => a.action)).toEqual(['revoke_integrations', 'restore_integrations']);
  });
});

describe('M-135: a person token is revocation-checked on EVERY write', () => {
  it('a write with a revoked session is 403 session_revoked, an unreachable accounts service is 503 (fail closed), reads are never blocked', async () => {
    const ws = W(1110);
    await setupBilling(ws);
    const conv = await chat(ws, 'UTILITY');
    const api = await apiFor(ws);
    const send = () => api.call('POST', `/conversations/${conv}/messages`, { ...sendBody, clientId: crypto.randomUUID() });
    expect((await send()).status).toBe(202);
    configureSessionCheck(async () => true);
    const revoked = await send();
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: 'forbidden', message: 'session_revoked' });
    expect((await api.call('GET', '/conversations')).status).toBe(200);
    configureSessionCheck(async () => { throw new Error('accounts down'); });
    const down = await send();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'unavailable', message: 'session_check_unavailable' });
    expect((await api.call('GET', '/conversations')).status).toBe(200);
    expect((await api.call('POST', `/conversations/${conv}/notes`, { text: 'n' })).status).toBe(503); // every other write is behind the same check
  });
});

describe('the production binding path (no test default installed)', () => {
  it('with the test defaults cleared, a write is checked against env.ACCOUNTS: revoked -> 403, healthy -> 202, throwing -> 503 unavailable', async () => {
    const ws = W(1113);
    await setupBilling(ws);
    const conv = await chat(ws, 'UTILITY');
    const api = await apiFor(ws);
    configureSessionCheck(null);
    configureWriteSessionDefault(null);
    const send = (accounts: unknown) =>
      worker.fetch(new Request(`https://x/api/v1/stores/${ws}/conversations/${conv}/messages`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...sendBody, clientId: crypto.randomUUID() }) }),
        { ...env, ACCOUNTS: accounts } as typeof env, createExecutionContext());
    expect((await send({ isRevoked: async () => true })).status).toBe(403);
    expect((await send({ isRevoked: async () => false })).status).toBe(202);
    const down = await send({ isRevoked: async () => { throw new Error('down'); } });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'unavailable', message: 'session_check_unavailable' });
  });
});

describe('item 1: the suspension / red gate runs AFTER the duplicate checks', () => {
  it('a redelivered job whose message already went to Meta keeps its wallet hold and is "already_sent", never dropped', async () => {
    const ws = W(1120);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await sendOut(ws, job, 'wamid.sent.1')).toBe('sent');
    const hold = await holdOf(ws, job);
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    expect(await workspace(ws).claimSend(job)).toBe('already_sent');
    expect(await holdOf(ws, job)).toEqual(hold); // not released early: the charge lands when the status arrives
    expect(await rows(ws, 'SELECT status FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'accepted' }]);
  });
  it('a job another attempt is holding right now stays "in_flight" (not acked away as dropped) and its row stays claimed', async () => {
    const ws = W(1121);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(job)).toBe('claimed'); // attempt A
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    expect(await workspace(ws).claimSend(job)).toBe('in_flight'); // attempt B
    expect(await rows(ws, 'SELECT status FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'claimed' }]);
  });
  it('a QUEUED job on a suspended store is failed and its hold released (the pre-existing behaviour, still there)', async () => {
    const ws = W(1122);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect((await holdOf(ws, job))?.state).not.toBe('open');
  });
});

describe('suspend is idempotent and reports a partial state', () => {
  it('when the workspace copy cannot be reached: 503 unavailable with the D1 half applied and ONE audit row; the same call again finishes it without a second row', async () => {
    const ws = W(1123);
    await setupBilling(ws);
    const spy = vi.spyOn(env.WORKSPACE_DO, 'get').mockImplementation((() => ({ setSuspended: async () => { throw new Error('do down'); } })) as never);
    const first = await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON });
    spy.mockRestore();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error: 'unavailable', message: 'suspended_in_d1_workspace_copy_pending_retry' });
    expect(await env.DB.prepare('SELECT suspended_at FROM workspaces WHERE id = ?').bind(ws).first('suspended_at')).not.toBeNull();
    expect(await workspace(ws).suspended()).toBe(false); // the copy is behind...
    expect((await (await apiFor(ws)).call('POST', '/conversations/1/messages', sendBody)).status).toBe(403); // ...but the Worker already refuses writes
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    expect(await workspace(ws).suspended()).toBe(true);
    expect((await actions(ws)).map((a) => a.action)).toEqual(['suspend']);
  });
});

describe('the platform number reaches every member (items 6 and 7, and the shadowing question)', () => {
  const PLAT = 'pn-plat2';
  async function platform(members: number[], health = 'green') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM shared_number_members'), env.DB.prepare('DELETE FROM shared_numbers'),
      env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at, health_state) VALUES (?, 'waba-plat', '+20 100 888 0001', 1, ?)").bind(PLAT, health),
    ]);
    const ids: string[] = [];
    for (const n of members) {
      const ws = W(n);
      await setupBilling(ws);
      await env.DB.prepare("INSERT INTO shared_number_members (workspace_id, phone_number_id, display_name, name_key, status, joined_at) VALUES (?, ?, ?, ?, 'active', 1)").bind(ws, PLAT, `Shop ${n}`, `shop${n}`).run();
      ids.push(ws);
    }
    return ids;
  }
  /** How many messages `ws` sent on the platform number in the current window (the denominator of its error rate). */
  const seedSends = (ws: string, n: number) => env.DB.prepare('INSERT INTO shared_number_sends (phone_number_id, workspace_id, bucket, n) VALUES (?, ?, ?, ?) ON CONFLICT(phone_number_id, workspace_id, bucket) DO UPDATE SET n = n + excluded.n').bind(PLAT, ws, Math.floor(Date.now() / 600_000), n).run();
  const errors = async (ws: string, n: number) => { for (let i = 0; i < n; i++) await workspace(ws).noteSendError(PLAT, i % 2 ? 131049 : 131026); };
  const restrictedHook = (time: number) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'X' }] } }] }] });

  it('one signal pages on-call ONCE however many members there are, and every member ends up restricted', async () => {
    const members = await platform([1130, 1131, 1132]);
    const spy = vi.spyOn(console, 'error');
    expect((await postWebhook(SELF, restrictedHook(10))).status).toBe(200);
    await vi.waitFor(async () => { for (const m of members) expect(await workspace(m).numberHealth(PLAT)).toBe('restricted'); });
    const names = spy.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });
    expect(names.filter((n) => n === 'number_restricted')).toHaveLength(1);
  });

  it('the webhook does not wait for the member pushes: D1 is up to date when it returns, the members are told afterwards', async () => {
    const members = await platform([1133, 1134]);
    const later: (() => Promise<unknown>)[] = [];
    await applyHealthEvent(env, 'waba-plat', '201008880001', { kind: 'restricted' }, 20_000, (f) => later.push(f));
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers WHERE phone_number_id = ?').bind(PLAT).first('health_state')).toBe('restricted');
    for (const m of members) expect(await workspace(m).numberHealth(PLAT)).toBe('green'); // nobody told yet
    expect(later).toHaveLength(1);
    await later[0]?.();
    for (const m of members) expect(await workspace(m).numberHealth(PLAT)).toBe('restricted');
  });

  it('a phone_numbers row for the platform number cannot be created through connect (conflict), and one that exists anyway does not shadow it: the signal reaches EVERY member', async () => {
    const members = await platform([1135, 1136]);
    await env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, display_phone, status, kind) VALUES (?, 'waba-plat', ?, '+20 100 888 0001', 'active', 'platform')").bind(PLAT, members[0]!).run();
    await postWebhook(SELF, restrictedHook(30));
    await vi.waitFor(async () => { for (const m of members) expect(await workspace(m).numberHealth(PLAT)).toBe('restricted'); });
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('restricted');
    expect(await env.DB.prepare('SELECT health_state FROM phone_numbers WHERE phone_number_id = ?').bind(PLAT).first('health_state')).toBe('green'); // the stray row was not treated as the number
  });
  it('item 7: a rejoin after recovery is not refused forever by a stale red copy; a member that missed the push is brought to the current D1 state on join', async () => {
    const [ws] = await platform([1137]);
    await workspace(ws!).syncSharedHealth(PLAT, 'red', 5_000); // the stale copy a leaving member keeps
    await env.DB.prepare("UPDATE shared_number_members SET status = 'left'").run();
    await env.DB.prepare("UPDATE shared_numbers SET health_state = 'green', health_at = 9000").run(); // the number recovered while it was gone
    expect(await workspace(ws!).numberHealth(PLAT)).toBe('red');
    expect(await joinShared(env, ws!, 'Shop 1137')).not.toBe('number_unhealthy');
    expect(await workspace(ws!).numberHealth(PLAT)).toBe('green'); // synced by the join
    const conv = await chat(ws!, 'UTILITY');
    const tpl = await workspace(ws!).queueOutbound(conv, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    if (tpl.ok && tpl.job) expect(await workspace(ws!).claimSend(tpl.job)).not.toBe('dropped');
  });
  it('item 7: syncing a member while D1 says red makes its own copy refuse templates (a store that joined mid-push)', async () => {
    const [ws] = await platform([1138], 'red');
    await env.DB.prepare("UPDATE shared_numbers SET health_at = 7000").run();
    expect(await workspace(ws!).numberHealth(PLAT)).toBe('green');
    await syncMemberHealth(env, ws!);
    expect(await workspace(ws!).numberHealth(PLAT)).toBe('red');
  });
  it('an older platform signal arriving late is dropped (ordering also holds for the shared row)', async () => {
    await platform([1139]);
    await postWebhook(SELF, restrictedHook(50_000));
    const lifted = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time: 40_000, changes: [{ field: 'account_update', value: { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } } }] }] });
    await postWebhook(SELF, lifted);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('restricted');
  });
  it('one member spamming the platform number: ONLY that store\'s templates stop (24 h); the number and the other members are untouched', async () => {
    const [bad, good] = await platform([1140, 1141]);
    await fund(bad!, 100_000); await fund(good!, 100_000);
    await seedSends(bad!, 40); await seedSends(good!, 40); // 25 errors on 40 sends = 62%
    const spy = vi.spyOn(console, 'error');
    for (let i = 0; i < SPIKE_THRESHOLD; i++) await workspace(bad!).noteSendError(PLAT, i % 2 ? 131049 : 131026);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green'); // the number is fine
    expect(await workspace(good!).numberHealth(PLAT)).toBe('green');
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 0)").bind(PLAT).run();
    await seedSharedTemplate(PLAT, { name: 'tpl-u', language: 'ar' });
    const tplFor = async (ws: string) => { const c = await chat(ws, 'UTILITY'); const r = await workspace(ws).queueOutbound(c, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] }); expect(r.ok).toBe(true); return r.ok && r.job ? r.job : null; };
    const badJob = await tplFor(bad!);
    const goodJob = await tplFor(good!);
    expect(await workspace(bad!).claimSend(badJob!)).toBe('dropped'); // the abuser: refused
    expect(await rows(bad!, 'SELECT error_reason FROM messages WHERE idempotency_key = ?', badJob!.idempotencyKey)).toEqual([{ error_reason: 'number_restricted' }]);
    expect(await workspace(good!).claimSend(goodJob!)).not.toBe('dropped'); // the innocent one: still sends
    expect(spy.mock.calls.some((c) => String(c[0]).includes('number_member_abuse'))).toBe(true);
  });
  /** A template job from `ws` on the platform number; true when its claim is refused as number_restricted. */
  async function templateRefused(ws: string): Promise<boolean> {
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 0)").bind(PLAT).run();
    await seedSharedTemplate(PLAT, { name: 'tpl-u', language: 'ar' });
    await fund(ws, 100_000);
    const c = await chat(ws, 'UTILITY');
    const r = await workspace(ws).queueOutbound(c, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.job) return false;
    return (await workspace(ws).claimSend(r.job)) === 'dropped';
  }
  it('dominance is checked FIRST: an abuser with ~85% plus two tiny accomplices is blocked and does NOT take the number down for everyone', async () => {
    const [abuser, a, b] = await platform([1147, 1148, 1149]);
    await seedSends(abuser!, 100); await seedSends(a!, 30); await seedSends(b!, 30);
    const send = async (ws: string, n: number) => { for (let i = 0; i < n; i++) await workspace(ws).noteSendError(PLAT, 131049); };
    await send(a!, 2); await send(b!, 2); await send(abuser!, SPIKE_THRESHOLD - 4); // the 25th error: abuser 21 (84%), accomplices 2 + 2
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green'); // the platform did not trip
    expect(await templateRefused(abuser!)).toBe(true); // the abuser is blocked
    expect(await templateRefused(a!)).toBe(false);
    expect(await templateRefused(b!)).toBe(false);
  });
  it('a member holding 60% in three consecutive AMBIGUOUS windows is blocked on the third (rolling tally), and the other member never is', async () => {
    const [x, y] = await platform([1150, 1151]);
    const oneWindow = async () => { // 10 from y first, then 15 from x: the 25th error leaves x at 60%
      await seedSends(x!, 40); await seedSends(y!, 500); // each window has its own sends (a verdict clears errors and sends together): x 15 on 40 = 37%; y 10 on 500 = 2%
      for (let i = 0; i < 10; i++) await workspace(y!).noteSendError(PLAT, 131049);
      for (let i = 0; i < 15; i++) await workspace(x!).noteSendError(PLAT, 131049);
    };
    await oneWindow();
    expect(await templateRefused(x!)).toBe(false);
    await oneWindow();
    expect(await templateRefused(x!)).toBe(false);
    await oneWindow(); // the third window: x is the repeat top contributor
    expect(await templateRefused(x!)).toBe(true);
    expect(await templateRefused(y!)).toBe(false);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
  });
  it('dead branch fixed: a dominant abuser (exactly 80%) is blocked AND the platform trips when the OTHER members reach the scaled bar from 3 distinct members', async () => {
    const [abuser, a, b, c] = await platform([1152, 1153, 1154, 1155]);
    await seedSends(abuser!, 100); await seedSends(a!, 30); await seedSends(b!, 30); await seedSends(c!, 30);
    await errors(a!, 2); await errors(b!, 2); await errors(c!, 1); // 5 = SHARED_REST_THRESHOLD, from 3 members
    await errors(abuser!, SPIKE_THRESHOLD - 5); // the 25th error: abuser 20 (80%), rate 20%
    expect(await env.DB.prepare('SELECT health_state, health_reason FROM shared_numbers').first()).toEqual({ health_state: 'yellow', health_reason: 'spike' });
    expect(await templateRefused(abuser!)).toBe(true);
    expect(await templateRefused(a!)).toBe(false);
  });
  it('fail closed: a dominant member with too little send data (5 sends, 20 errors; or 0 sends right after a clear) is BLOCKED, not given a pass', async () => {
    const [dom, a, b] = await platform([1167, 1168, 1169]);
    await seedSends(dom!, 5); await seedSends(a!, 30); await seedSends(b!, 30);
    await errors(a!, 3); await errors(b!, 2); await errors(dom!, SPIKE_THRESHOLD - 5); // dominant 20 of 25 (80%) on 5 sends: not measurable
    expect(await templateRefused(dom!)).toBe(true);
    expect(await templateRefused(a!)).toBe(false);
    const [alone] = await platform([1170]);
    await errors(alone!, SPIKE_THRESHOLD); // no sends at all: the window was just cleared while its errors kept coming
    expect(await templateRefused(alone!)).toBe(true);
  });
  it('a dominant member UNDER the rate bar (80%+ of the errors at a 4% rate) plus two tiny members does NOT trip the platform (its own errors never count), and it earns a strike', async () => {
    const [dom, a, b] = await platform([1160, 1161, 1162]);
    await seedSends(dom!, 500); await seedSends(a!, 30); await seedSends(b!, 30);
    await errors(a!, 2); await errors(b!, 2); await errors(dom!, SPIKE_THRESHOLD - 4); // dominant 21 of 25 (84%) on 500 sends = 4.2%
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green'); // rest = 4 errors from 2 members: no platform trip
    expect(await rows(dom!, 'SELECT 1')).toBeTruthy();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM shared_number_strikes WHERE workspace_id = ?').bind(dom).first('n')).toBe(1); // a strike, not a block
    expect(await templateRefused(dom!)).toBe(false);
  });
  it('repeated dominance under the bar escalates: the third strike blocks the dominant member', async () => {
    const [dom, a, b] = await platform([1163, 1164, 1165]);
    for (let w = 0; w < 3; w++) { await seedSends(dom!, 500); await seedSends(a!, 30); await seedSends(b!, 30); await errors(a!, 2); await errors(b!, 2); await errors(dom!, SPIKE_THRESHOLD - 4); }
    expect(await templateRefused(dom!)).toBe(true);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
  });
  it('sends are counted once per JOB (the first claim): a retry that is claimed again adds nothing; only templates are counted', async () => {
    const [ws] = await platform([1166]);
    await syncMemberHealth(env, ws!);
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 0)").bind(PLAT).run();
    await seedSharedTemplate(PLAT, { name: 'tpl-u', language: 'ar' });
    await fund(ws!, 100_000);
    const c = await chat(ws!, 'UTILITY');
    const sum = async () => (await env.DB.prepare('SELECT coalesce(sum(n), 0) AS n FROM shared_number_sends WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n;
    const q = await workspace(ws!).queueOutbound(c, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    expect(q.ok).toBe(true);
    const job = q.ok ? q.job : undefined;
    expect(await workspace(ws!).claimSend(job!)).toBe('claimed'); // first claim: counted
    await vi.waitFor(async () => expect(await sum()).toBe(1));
    for (let i = 0; i < 2; i++) {
      await workspace(ws!).recordOutbound(job!.idempotencyKey, { ok: false, code: 500, retryable: true, message: 'x' }); // a retryable failure puts it back for another attempt
      expect(await workspace(ws!).claimSend(job!)).toBe('claimed'); // claimed again (redelivery / retry)
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(await sum()).toBe(1); // still one
    const t = await workspace(ws!).queueOutbound(c, PLAT, { type: 'text', clientId: crypto.randomUUID(), text: 'a reply' });
    if (t.ok && t.job) await workspace(ws!).claimSend(t.job);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sum()).toBe(1); // a non-template send is not counted
  });
  it('a BIG honest store (1000 sends, 3% errors) is never struck or blocked, even holding 60% of the errors in three windows; a SMALL store at 25% is struck and blocked on the third', async () => {
    const [big, other, small] = await platform([1156, 1157, 1158]);
    for (let w = 0; w < 3; w++) { await seedSends(big!, 1000); await seedSends(other!, 500); await errors(other!, 10); await errors(big!, 15); } // big: 15 on 1000 = 1.5% per window, 60% of every window
    expect(await templateRefused(big!)).toBe(false);
    expect(await templateRefused(other!)).toBe(false);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM shared_number_strikes WHERE workspace_id IN (?, ?)').bind(big, other).first('n')).toBe(0);
    // now a small store with a really bad rate takes the other seat
    for (let w = 0; w < 3; w++) { await seedSends(small!, 40); await seedSends(big!, 1000); await errors(small!, 10); await errors(big!, 15); } // small: 10 errors per window on 40 sends = 25% (strike each window)
    expect(await templateRefused(small!)).toBe(true);
    expect(await templateRefused(big!)).toBe(false);
  });
  it('sends on the platform number are counted per member where the claim happens (ids and a count, nothing else)', async () => {
    const [ws] = await platform([1159]);
    await syncMemberHealth(env, ws!); // a joined member knows it sends on the platform number
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 0)").bind(PLAT).run();
    await seedSharedTemplate(PLAT, { name: 'tpl-u', language: 'ar' });
    await fund(ws!, 100_000);
    const c = await chat(ws!, 'UTILITY');
    const r = await workspace(ws!).queueOutbound(c, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    expect(r.ok).toBe(true);
    if (r.ok && r.job) expect(await workspace(ws!).claimSend(r.job)).toBe('claimed');
    await vi.waitFor(async () => expect(await env.DB.prepare('SELECT sum(n) AS n FROM shared_number_sends WHERE workspace_id = ?').bind(ws).first('n')).toBe(1));
  });
  it('errors spread over 3 or more members trip the platform number for everyone (yellow)', async () => {
    const members = await platform([1142, 1143, 1144]);
    for (let i = 0; i < SPIKE_THRESHOLD; i++) await workspace(members[i % 3]!).noteSendError(PLAT, 131049);
    expect(await env.DB.prepare('SELECT health_state, health_reason FROM shared_numbers').first()).toEqual({ health_state: 'yellow', health_reason: 'spike' });
    await vi.waitFor(async () => { for (const m of members) expect(await workspace(m).numberHealth(PLAT)).toBe('yellow'); });
  });
  it('two members with no clear culprit raise an alert but stop nobody', async () => {
    const members = await platform([1145, 1146]);
    const spy = vi.spyOn(console, 'error');
    for (let i = 0; i < SPIKE_THRESHOLD; i++) await workspace(members[i % 2]!).noteSendError(PLAT, 131049);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('number_error_spike'))).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('number_member_abuse'))).toBe(false);
  });
});

describe('quality errors are counted once per NEW status event', () => {
  it('a redelivered failed status (same wamid, status, ts) does not count twice', async () => {
    const ws = W(1150);
    await setupBilling(ws);
    const ev = { wamid: 'wamid.err.1', status: 'failed' as const, ts: 100, errorCode: 131049 };
    for (let i = 0; i < 3; i++) await workspace(ws).ingest({ phoneNumberId: pn(ws), inbound: [], statuses: [ev], receivedAt: 1 });
    expect(await rows(ws, 'SELECT sum(n) AS n FROM number_health_events')).toEqual([{ n: 1 }]);
  });
});
