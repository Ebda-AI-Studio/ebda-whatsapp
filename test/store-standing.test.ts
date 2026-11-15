import { env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { clearIntegrationCache } from '../src/core/identity/integration';
import { configureSessionCheck } from '../src/core/identity/session';
import { makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, jobOf, queueText, setupBilling } from './helpers/billing';
import { deliver, iso, storeEvent } from './helpers/store-link';
import { exec, own, rows, workspace } from './helpers/workspace';
import { abuseSuspended } from '../src/core/ops/offboarding';

/**
 * STORE-STANDING-1 (ebda-store #839): a Store store that is suspended or deleted stops every Ebda Chat send that costs money (queued sends,
 * campaigns, automatic and AI replies), promptly and on its own copy; reactivation re-opens it; an older event never wins; the operator's
 * suspension and the Store's hold never lift each other.
 */
useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); clearIntegrationCache(); });
afterEach(() => configureSessionCheck(null));

const suspended = (ws: string, at = Date.now(), reason = 'unpaid') => storeEvent(ws, 'store.suspended', { reason, at: iso(at) });
const reactivated = (ws: string, at = Date.now()) => storeEvent(ws, 'store.reactivated', { at: iso(at) });
const deleted = (ws: string, at = Date.now()) => storeEvent(ws, 'store.deleted', { at: iso(at) });
const d1 = (ws: string) => env.DB.prepare('SELECT suspended_at IS NOT NULL AS on_, suspended_reason AS reason FROM workspaces WHERE id = ?').bind(ws).first<{ on_: number; reason: string | null }>();
const sendBody = () => ({ type: 'text', clientId: crypto.randomUUID(), text: 'hello' });

describe('store.suspended / store.reactivated (STORE-STANDING-1)', () => {
  it('a suspended store: a queued send fails workspace_suspended in the workspace, the API refuses sends, the agent is off; reactivation re-opens', async () => {
    const ws = W(1170);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueText(ws, conv));
    const api = await apiFor(ws);
    expect((await deliver([suspended(ws)])).explicitAcks).toEqual(['e0']);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'workspace_suspended' }]);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_suspended' });
    const blocked = await api.call('POST', `/conversations/${conv}/messages`, sendBody());
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: 'forbidden', message: 'workspace_suspended' });

    await deliver([reactivated(ws)]);
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await d1(ws)).toEqual({ on_: 0, reason: null });
    expect((await api.call('POST', `/conversations/${conv}/messages`, sendBody())).status).toBe(202);
    expect(await workspace(ws).claimSend(jobOf(await queueText(ws, conv, 'again')))).toBe('claimed');
  });

  it('a suspension pauses every running campaign (store_suspended); reactivation resumes none', async () => {
    const ws = W(1171);
    await own(ws);
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const c = await makeCampaign(ws);
    await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", c.id);
    await deliver([suspended(ws)]);
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns WHERE id = ?', c.id)).toEqual([{ status: 'paused', pause_reason: 'store_suspended' }]);
    expect(await workspace(ws).sendCampaign(c.id)).not.toEqual({ ok: true });
    await deliver([reactivated(ws)]);
    expect((await rows<{ status: string }>(ws, 'SELECT status FROM campaigns WHERE id = ?', c.id))[0]!.status).toBe('paused');
  });

  it('an older event never wins: a reactivation older than the suspension is dropped (queue order is not guaranteed)', async () => {
    const ws = W(1172);
    await setupBilling(ws);
    const t = Date.now();
    await deliver([suspended(ws, t)]);
    await deliver([reactivated(ws, t - 60_000)]);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_suspended' });
    await deliver([reactivated(ws, t + 1)]);
    expect(await workspace(ws).suspended()).toBe(false);
  });

  it('store.deleted holds everything; a delete for a workspace Ebda Chat never registered is acknowledged, not retried', async () => {
    const ws = W(1173);
    await setupBilling(ws);
    await deliver([deleted(ws)]);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_deleted' });
    const unknown = await deliver([deleted(W(1179)), suspended(W(1179))]);
    expect(unknown.explicitAcks).toEqual(['e0', 'e1']);
    expect(unknown.retryMessages).toEqual([]);
  });

  it('the operator unsuspend never lifts the Store hold, and a Store reactivation never lifts the operator suspension', async () => {
    const ws = W(1174);
    await setupBilling(ws);
    await deliver([suspended(ws)]);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-11-15' })).status).toBe(200);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/unsuspend`, { reason: 'resolved with the owner' })).status).toBe(200);
    expect(await workspace(ws).suspended()).toBe(true); // the Store still says suspended
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_suspended' });

    await deliver([reactivated(ws)]);
    expect(await workspace(ws).suspended()).toBe(false);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-11-15' })).status).toBe(200);
    await deliver([suspended(ws, Date.now() + 1)]);
    await deliver([reactivated(ws, Date.now() + 2)]);
    expect(await workspace(ws).suspended()).toBe(true); // the operator's suspension stays
    expect((await d1(ws))!.on_).toBe(1);
  });
});

describe('Store hold vs offboarding (STORE-STANDING-1)', () => {
  it('a Store hold is not an abuse suspension, but an operator suspension on top of it is, and outlives the reactivation in D1', async () => {
    const ws = W(1175);
    await setupBilling(ws);
    await deliver([suspended(ws)]);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_suspended' });
    expect(await abuseSuspended(env, ws)).toBe(false); // a Store hold never holds an erasure
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-11-15' })).status).toBe(200);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'abuse report 2026-11-15' });
    expect(await abuseSuspended(env, ws)).toBe(true);
    await deliver([reactivated(ws, Date.now() + 1)]);
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'abuse report 2026-11-15' });
    expect(await workspace(ws).suspended()).toBe(true);
  });
});
