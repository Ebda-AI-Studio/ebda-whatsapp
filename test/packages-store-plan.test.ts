import { env, runInDurableObject } from 'cloudflare:test';
import { marketingBlocked } from '../src/core/billing/entitlements';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSubscription } from '../src/core/billing/subscriptions';
import { deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000082${String(n).padStart(2, '0')}`;
const DAY = 86_400_000;
const link = useStoreLink();
const plan = (ws: string, includesWhatsApp: boolean, t: number, extra: Record<string, unknown> = {}, id?: string) =>
  storeEvent(ws, 'store.plan_changed', { planCode: 'business', includesWhatsApp, ownerUserId: 'u', effectiveAt: iso(t), status: 'active', periodEnd: iso(t + 31 * DAY), ...extra }, { occurredAt: iso(t), ...(id ? { id } : {}) });
const blocked = (ws: string) => runInDurableObject(workspace(ws), (_i, state) => marketingBlocked(state.storage.sql));
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, version, source, period_end FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; version: number; source: string; period_end: number }>();
const writes = async (ws: string) => (await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first<{ n: number }>())!.n;

describe('D3: an incomplete store.plan_changed never grants access', () => {
  const noise = () => { const e: string[] = []; vi.spyOn(console, 'error').mockImplementation((m: unknown) => { e.push(String(m)); }); return e; };
  afterEach(() => vi.restoreAllMocks());
  it('includesWhatsApp=true without a status creates no package, keeps marketing blocked and tells a human', async () => {
    const ws = W(30);
    await storeWorkspace(ws);
    const errors = noise();
    await deliver([plan(ws, true, Date.now(), { status: undefined })]);
    expect(await sub(ws)).toBeNull();
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 0, packageId: 'test-plan' }); // still the fixture's own package, nothing from the Store
    expect(errors.join('\n')).toContain('store_plan_incomplete');
  });
  it('includesWhatsApp=true with a status but no periodEnd grants nothing either (no invented 31 days)', async () => {
    const ws = W(31);
    await storeWorkspace(ws);
    const errors = noise();
    await deliver([plan(ws, true, Date.now(), { periodEnd: undefined })]);
    expect(await sub(ws)).toBeNull();
    expect(errors.join('\n')).toContain('store_plan_incomplete');
  });
  it('an incomplete event after a complete one changes nothing (no extension, no status reset)', async () => {
    const ws = W(32);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, true, t, { status: 'past_due' })]);
    const before = await sub(ws);
    noise();
    await deliver([plan(ws, true, t + 1000, { status: undefined, periodEnd: undefined })]);
    expect(await sub(ws)).toEqual(before);
  });
  it('a cancellation (includesWhatsApp=false) needs no status: removing access is always safe', async () => {
    const ws = W(33);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, true, t)]);
    await deliver([plan(ws, false, t + 1000, { status: undefined, periodEnd: undefined })]);
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'cancelled' });
  });
});

describe('store.plan_changed -> store-included package', () => {
  it('includesWhatsApp=true with status and periodEnd makes the package active until periodEnd, and marketing is allowed', async () => {
    const ws = W(1);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, true, t)]);
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'active', source: 'store_plan', period_end: t + 31 * DAY });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'store-included', status: 'active', version: 1 });
    expect(await blocked(ws)).toBe(false);
    expect(link.sink.sent.map((e) => e.type)).toEqual(['whatsapp.entitlement_changed']);
  });

  it('uses the status and periodEnd the Store sends', async () => {
    const ws = W(2);
    await storeWorkspace(ws);
    const t = Date.now();
    const end = t + 5 * DAY;
    await deliver([plan(ws, true, t, { status: 'past_due', periodEnd: iso(end) })]);
    expect(await sub(ws)).toMatchObject({ status: 'past_due', period_end: end });
  });

  it('includesWhatsApp=false cancels the store-included subscription and blocks marketing', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, true, t)]);
    await deliver([plan(ws, false, t + 1000)]);
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'cancelled', version: 2 });
    // WA-CANCEL-1: cancelled with the paid period still running is in effect, so marketing is NOT blocked by `cancelled` itself ...
    expect(await blocked(ws)).toBe(false);
    // ... and the workspace expires itself at period_end from its own copy, with no event.
    await exec(ws, 'UPDATE entitlements SET period_end = ?', Date.now() - 1);
    expect(await blocked(ws)).toBe(true);
  });

  it('false while a purchased (or operator) package exists leaves it unchanged; so does a later true', async () => {
    const ws = W(4);
    await storeWorkspace(ws);
    await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, created_at) VALUES ('gold', 'Gold', 50000, 300, 1)").run();
    await setSubscription(env, { workspaceId: ws, packageId: 'gold', status: 'active', periodStart: Date.now() - DAY, periodEnd: Date.now() + 20 * DAY, source: 'purchase', ref: 'o1' });
    const t = Date.now();
    await deliver([plan(ws, false, t)]);
    await deliver([plan(ws, true, t + 1000)]);
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active', version: 1, source: 'purchase' });
    expect(await writes(ws)).toBe(1);
  });

  it('an event with an older effectiveAt than the last applied one is ignored', async () => {
    const ws = W(5);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, true, t)]);
    await deliver([plan(ws, false, t - 9000)]);
    expect(await sub(ws)).toMatchObject({ status: 'active', version: 1 });
  });

  it('a replayed event id writes once', async () => {
    const ws = W(6);
    await storeWorkspace(ws);
    const e = plan(ws, true, Date.now());
    await deliver([e]);
    await deliver([e], 2);
    expect(await writes(ws)).toBe(1);
    expect(await rows(ws, 'SELECT version FROM entitlements')).toEqual([{ version: 1 }]);
  });
});
