import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { findPackageOrder, grantOrder, startPackageCheckout } from '../src/core/billing/package-orders';
import { applyStorePlan } from '../src/core/billing/store-plan';
import { STORE_INCLUDED, fallbackToStorePlan, setSubscription } from '../src/core/billing/subscriptions';
import { autoConfirmInstapay } from '../src/core/billing/instapay-auto';
import { configureSessionCheck } from '../src/core/identity/session';
import { createStandaloneWorkspace } from '../src/core/workspace-registry';
import worker from '../src/index';
import { apiKey, useApiKey } from './helpers/api';
import { aiEnv, goodAnswer, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { mint } from './helpers/issuer';
import { testKashier } from './helpers/kashier';
import { workspace } from './helpers/workspace';

useApiKey();
const kashier = testKashier();
const DAY = 86_400_000;
let n = 0;
/** A standalone workspace (`sw_...`), created the way PR-3 creates it. */
async function standalone(): Promise<string> {
  const r = await createStandaloneWorkspace(env, { ownerUserId: `standalone-owner-${Date.now()}-${++n}`, name: 'Acme', country: 'EG', inviteCodeHash: null });
  if (r.status !== 'created') throw new Error(r.status);
  return r.id;
}
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, source FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; source: string }>();
const SW_EVENT_PLAN = (ws: string) => ({ id: crypto.randomUUID(), type: 'store.plan_changed', storeId: ws, occurredAt: new Date().toISOString(), data: { planCode: 'business', includesWhatsApp: true, ownerUserId: 'u', effectiveAt: new Date().toISOString(), status: 'active', periodEnd: new Date(Date.now() + 31 * DAY).toISOString() } }) as never;

beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  sessionOk();
  await seedGold();
});
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

describe('CHAT-SA-6: a standalone workspace buys Chat packages', () => {
  it('a card purchase is granted as source purchase; the free store-included package cannot be bought', async () => {
    const ws = await standalone();
    const a = { workspaceId: ws, userId: 'u1', sessionId: 's1' };
    expect(await startPackageCheckout(env, { ...a, packageId: STORE_INCLUDED })).toEqual({ ok: false, reason: 'unknown_package' });
    const r = await startPackageCheckout(env, { ...a, packageId: 'gold' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = (await findPackageOrder(env, r.orderId))!;
    expect(await grantOrder(env, row, 'ref-1', Date.now(), { claim: true })).toBe('granted');
    expect(await sub(ws)).toEqual({ package_id: 'gold', status: 'active', source: 'purchase' });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'gold', status: 'active' });
  });
});

describe('CHAT-SA-6: nothing from a Store ever writes to a standalone workspace', () => {
  it('a store.plan_changed for an sw_ id is ignored: no subscription, no store_plan_applied row', async () => {
    const ws = await standalone();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await applyStorePlan(env, SW_EVENT_PLAN(ws))).toBe('ignored');
    expect(await sub(ws)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM store_plan_applied WHERE workspace_id = ?').bind(ws).first()).toBeNull();
    expect(log.mock.calls.join('\n')).toContain('standalone_store_plan_event');
  });
  it('the one writer refuses store-included, a store_plan source and a trial for an sw_ id, for every caller, and writes nothing', async () => {
    const ws = await standalone();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = Date.now();
    const base = { workspaceId: ws, periodStart: t, periodEnd: t + 31 * DAY, ref: 'x' };
    for (const a of [
      { ...base, packageId: STORE_INCLUDED, status: 'active' as const, source: 'store_plan' as const },
      { ...base, packageId: STORE_INCLUDED, status: 'active' as const, source: 'operator' as const },
      { ...base, packageId: 'gold', status: 'active' as const, source: 'store_plan' as const },
      { ...base, packageId: 'gold', status: 'trialing' as const, source: 'operator' as const },
      { ...base, packageId: 'gold', status: 'trialing' as const, source: 'purchase' as const },
    ]) expect(await setSubscription(env, a), JSON.stringify(a)).toMatchObject({ written: false, version: 0 });
    expect(await sub(ws)).toBeNull();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first()).toEqual({ n: 0 });
    // A paid Chat package by an operator is allowed (a deal / goodwill extension).
    expect(await setSubscription(env, { ...base, packageId: 'gold', status: 'active', source: 'operator' })).toMatchObject({ written: true });
  });
  it('a Store workspace is untouched by the guard: store-included still writes for a UUID id', async () => {
    const store = '00000000-0000-4000-8000-000000009911';
    await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(store, 's', 1).run();
    const t = Date.now();
    expect(await setSubscription(env, { workspaceId: store, packageId: STORE_INCLUDED, status: 'active', periodStart: t, periodEnd: t + DAY, source: 'store_plan', ref: 'x' })).toMatchObject({ written: true });
  });
  it('no store-included fallback after a bought package ends, even with a (forged) Store plan row', async () => {
    const ws = await standalone();
    const t = Date.now();
    await setSubscription(env, { workspaceId: ws, packageId: 'gold', status: 'active', periodStart: t - 40 * DAY, periodEnd: t - DAY, source: 'purchase', ref: 'o1' });
    await env.DB.prepare("INSERT INTO store_plan_applied (workspace_id, effective_at, event_id, includes_whatsapp, status, period_end, claimed) VALUES (?, 1, 'e1', 1, 'active', ?, 0)").bind(ws, t + 30 * DAY).run();
    expect(await fallbackToStorePlan(env, ws, t)).toBe(false);
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', source: 'purchase' });
  });
  it('the operator route refuses a trial for a standalone workspace', async () => {
    const ws = await standalone();
    const tok = await mint(apiKey(), { sub: '11111111-1111-4111-8111-111111111111', pa: 'super_admin', stores: [] });
    const call = (status: string) => worker.fetch(new Request(`https://x/api/v1/operator/workspaces/${ws}/subscription`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'gold', status, periodEnd: Date.now() + 10 * DAY, reason: 'goodwill extension for a pilot client' }) }), env, createExecutionContext());
    const r = await call('trialing');
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ message: 'standalone_no_trial' });
    expect((await call('active')).status).toBe(200);
  });
});

describe('CHAT-SA-6: the first InstaPay payment of a standalone workspace is always a person', () => {
  it('a first monthly purchase that would auto-confirm for a Store workspace waits for a person for an sw_ one; after a human-confirmed payment it is automatic again', async () => {
    await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run();
    await setMode('live');
    const store = '00000000-0000-4000-8000-000000009922';
    const control = await request(store, 'package');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000)), control.id)).toEqual({ state: 'auto_confirmed', reasons: [] }); // the same payment, a Store workspace: automatic
    const ws = await standalone();
    const first = await request(ws, 'package');
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(50_000)), first.id)).toEqual({ state: 'needs_human', reasons: ['FIRST_PAYMENT_OVER_CAP'] });
    expect((await reqRow(first.id))!.state).toBe('under_review');
    const topup = await request(ws, 'topup', { amountMinor: 10_000 });
    expect((await autoConfirmInstapay(aiEnv(goodAnswer(10_000)), topup.id)).state).toBe('needs_human'); // still no clean payment: still a person
    // A person confirms the first one: the workspace has history, the normal rules apply.
    await env.DB.prepare("UPDATE instapay_requests SET state = 'confirmed', decided_by = 'op-human', decided_at = ? WHERE id = ?").bind(Date.now(), first.id).run();
    const later = await request(ws, 'topup', { amountMinor: 10_000 });
    expect(await autoConfirmInstapay(aiEnv(goodAnswer(10_000)), later.id)).toEqual({ state: 'auto_confirmed', reasons: [] });
    void seedSub;
  });
});
