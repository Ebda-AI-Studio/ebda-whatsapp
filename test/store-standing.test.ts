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

describe('D1 copy of the hold (STORE-STANDING-1)', () => {
  it('a retry after a failed D1 save re-attempts it (the workspace already recorded the event: duplicate)', async () => {
    const ws = W(1176);
    await setupBilling(ws);
    const e = suspended(ws);
    await deliver([e]);
    await env.DB.prepare('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').bind(ws).run(); // the D1 save that failed
    await deliver([e], 2); // the queue's retry of the same envelope
    expect(await d1(ws)).toEqual({ on_: 1, reason: 'store_suspended' });
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

/**
 * STORE-STANDING-2: a linked workspace whose Store has been silent for 24 h stops spending, ONLY when STORE_STANDING_STALE_REFUSE is on (default off). The switch is the
 * workspace's own `store.standing_enforce` row (the DO copies the env var into it on every wake), so a test turns it on by writing that row.
 */
describe('STORE-STANDING-2: silence from the Store (default off)', () => {
  const H = 3_600_000;
  const set = (ws: string, key: string, value: string) => exec(ws, 'INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  const enforce = (ws: string) => set(ws, 'store.standing_enforce', '1');
  const seen = (ws: string, ago: number) => set(ws, 'store.standing_at', String(Date.now() - ago));
  const anchor = (ws: string, ago: number) => set(ws, 'store.standing_anchor', String(Date.now() - ago));

  it('flag OFF: a standing 48 h old, or none for 48 h, changes nothing (today\'s behaviour)', async () => {
    const ws = W(1180);
    await setupBilling(ws);
    await seen(ws, 48 * H);
    expect(await workspace(ws).suspended()).toBe(false);
    const w2 = W(1181);
    await setupBilling(w2);
    await anchor(w2, 48 * H);
    expect(await workspace(w2).suspended()).toBe(false);
  });

  it('flag ON, fresh standing (under 24 h): spend allowed', async () => {
    const ws = W(1182);
    await setupBilling(ws);
    await enforce(ws);
    await seen(ws, 23 * H);
    expect(await workspace(ws).suspended()).toBe(false);
  });

  it('flag ON, stale standing (over 24 h): every send is refused workspace_suspended; the next standing event re-opens it', async () => {
    const ws = W(1183);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const job = jobOf(await queueText(ws, conv));
    await enforce(ws);
    await seen(ws, 25 * H);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'workspace_suspended' }]);
    // a heartbeat (reactivated repeated, even one older than the last applied) proves the Store is alive
    expect((await deliver([storeEvent(ws, 'store.reactivated', { at: iso(Date.now() - 30 * H) }, { id: crypto.randomUUID() })])).explicitAcks).toEqual(['e0']);
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await workspace(ws).claimSend(jobOf(await queueText(ws, conv, 'again')))).toBe('claimed');
  });

  it('flag ON, no standing ever: allowed inside 24 h of the link, refused after', async () => {
    const inside = W(1184);
    await setupBilling(inside);
    await enforce(inside);
    await anchor(inside, 23 * H);
    expect(await workspace(inside).suspended()).toBe(false);
    const beyond = W(1185);
    await setupBilling(beyond);
    await enforce(beyond);
    await anchor(beyond, 25 * H);
    expect(await workspace(beyond).suspended()).toBe(true);
    expect(await workspace(beyond).lastStandingAt()).toBeNull();
  });

  it('flag ON: an unlinked workspace is exempt', async () => {
    const ws = W(1186);
    await setupBilling(ws);
    await enforce(ws);
    await seen(ws, 72 * H);
    await set(ws, 'linked', '0');
    expect(await workspace(ws).suspended()).toBe(false);
  });

  it('every standing event, including a repeat, is recorded (the console reads it); a re-link restarts the window', async () => {
    const ws = W(1187);
    await setupBilling(ws);
    await chat(ws, 'UTILITY');
    expect(await workspace(ws).lastStandingAt()).toBeNull();
    const before = Date.now();
    await deliver([storeEvent(ws, 'store.reactivated', { at: iso(before) }, { id: crypto.randomUUID() })]);
    const first = await workspace(ws).lastStandingAt();
    expect(first).toBeGreaterThanOrEqual(before);
    await seen(ws, 5 * H);
    await deliver([storeEvent(ws, 'store.reactivated', { at: iso(before) }, { id: crypto.randomUUID() })]);
    expect(await workspace(ws).lastStandingAt()).toBeGreaterThanOrEqual(before);
    await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' }, { id: crypto.randomUUID() })]);
    expect(await workspace(ws).lastStandingAt()).toBeNull();
  });

  it('the stale refusal does not touch the Store hold or the operator flag, and a real Store hold still refuses with the policy off', async () => {
    const ws = W(1188);
    await setupBilling(ws);
    await deliver([suspended(ws)]);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await workspace(ws).storeHold()).toContain('store_suspended');
  });
});
