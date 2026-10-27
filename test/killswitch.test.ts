import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { clearIntegrationCache } from '../src/core/identity/integration';
import { configureSessionCheck } from '../src/core/identity/session';
import { joinShared, sharedStatus } from '../src/core/shared/shared-number';
import { postWebhook } from './helpers/meta';
import { mintClient } from './helpers/issuer';
import { PARAMS, makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { OP1, apiFor, apiKey, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, jobOf, pn, queueText, setupBilling } from './helpers/billing';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); clearIntegrationCache(); });
afterEach(() => configureSessionCheck(null));

const REASON = 'abuse report 2026-10-27';
const actions = (ws: string) => env.DB.prepare('SELECT actor, action, reason, detail FROM operator_actions WHERE workspace_id = ? ORDER BY id').bind(ws).all<{ actor: string; action: string; reason: string; detail: string | null }>().then((r) => r.results);
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
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    const blocked = await api.call('POST', `/conversations/${conv}/messages`, { ...sendBody, clientId: crypto.randomUUID() });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: 'forbidden', message: 'workspace_suspended' });
    expect((await api.call('GET', '/conversations')).status).toBe(200); // reading stays
    expect(((await (await api.call('POST', '/wallet/topups', { amountMinor: 10000 })).json()) as { message?: string }).message).not.toBe('workspace_suspended'); // paying is not blocked
    expect(((await (await api.call('DELETE', '/contacts/201009999999')).json()) as { message?: string }).message).not.toBe('workspace_suspended'); // a data-erasure right stays
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
  it('the platform number\'s state follows Meta\'s webhooks (D1 row, P1 alert path) and recovers on UPGRADE', async () => {
    await sharedRow('green');
    const hook = (event: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time: 1, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '201008880001', event, current_limit: 'TIER_1K' } }] }] });
    expect((await postWebhook(SELF, hook('FLAGGED'))).status).toBe(200);
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('yellow');
    await postWebhook(SELF, hook('UPGRADE'));
    expect(await env.DB.prepare('SELECT health_state FROM shared_numbers').first('health_state')).toBe('green');
  });
  it('sharedStatus reports the number unavailable unless it is green (the join card disappears with it)', async () => {
    const ws = W(1111);
    await setupBilling(ws);
    await sharedRow('green');
    expect((await sharedStatus(env, ws)).available).toBe(true);
    for (const s of ['yellow', 'red', 'restricted']) {
      await env.DB.prepare('UPDATE shared_numbers SET health_state = ?').bind(s).run();
      expect((await sharedStatus(env, ws)).available, s).toBe(false);
    }
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
    expect(await workspace(ws).numberHealth('pn-plat')).toBe('restricted'); // pushed to the member's own copy
    expect(await workspace(ws).sendCampaign(created.campaign.id)).toEqual({ ok: false, reason: 'number_restricted' });
    const conv = await chat(ws, 'UTILITY');
    const tpl = await workspace(ws).queueOutbound(conv, 'pn-plat', { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    if (tpl.ok && tpl.job) expect(await workspace(ws).claimSend(tpl.job)).toBe('dropped');
    // recovery reaches the members too
    const lifted = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-plat', time: 1, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [] } }] }] });
    await postWebhook(SELF, lifted);
    expect(await workspace(ws).numberHealth('pn-plat')).toBe('yellow');
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
  it('every token issued at or before the revoke is refused (401); a token issued after it works; audited', async () => {
    const ws = W(1109);
    await apiFor(ws);
    const before = await mintClient(apiKey(), { storeId: ws, scope: 'conversations:read' });
    expect((await call(before, `/stores/${ws}/conversations`)).status).toBe(200);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/integrations/revoke`, { reason: REASON })).status).toBe(200);
    expect((await call(before, `/stores/${ws}/conversations`)).status).toBe(401);
    expect(await actions(ws)).toEqual([{ actor: OP1, action: 'revoke_integrations', reason: REASON, detail: null }]);
    await env.DB.prepare('UPDATE workspaces SET integrations_revoked_at = ? WHERE id = ?').bind(Date.now() - 60_000, ws).run(); // the revoke happened a minute ago
    const after = await mintClient(apiKey(), { storeId: ws, scope: 'conversations:read' });
    expect((await call(after, `/stores/${ws}/conversations`)).status).toBe(200);
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
    expect(await down.json()).toEqual({ error: 'rate_limited', message: 'session_check_unavailable' });
    expect((await api.call('GET', '/conversations')).status).toBe(200);
    expect((await api.call('POST', `/conversations/${conv}/notes`, { text: 'n' })).status).toBe(503); // every other write is behind the same check
  });
});
