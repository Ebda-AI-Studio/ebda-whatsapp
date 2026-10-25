import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { reconcileEntitlements, pushEntitlement } from '../src/core/billing/subscriptions';
import { openChat, own, rows, seedNumber, workspace } from './helpers/workspace';
import { seedTemplate } from './helpers/campaigns';

const W = (n: number) => `00000000-0000-4000-8000-0000000071${String(n).padStart(2, '0')}`;
const DAY = 86_400_000;
const NOW = Date.now();
const ev = (o: Record<string, unknown> = {}) => ({ version: 1, packageId: 'basic', status: 'active' as const, periodStart: NOW - DAY, periodEnd: NOW + 29 * DAY, aiCredits: 100, ...o });

describe('entitlements: versioned copy', () => {
  it('applies a newer version and ignores an older or equal one', async () => {
    const ws = workspace(W(1));
    expect(await ws.applyEntitlement(ev({ version: 5 }))).toBe('applied');
    expect(await ws.applyEntitlement(ev({ version: 4, status: 'cancelled' }))).toBe('stale');
    expect(await ws.applyEntitlement(ev({ version: 5, status: 'cancelled' }))).toBe('stale');
    expect((await ws.getEntitlement())?.status).toBe('active');
    expect(await ws.applyEntitlement(ev({ version: 6, status: 'past_due' }))).toBe('applied');
    expect((await ws.getEntitlement())?.status).toBe('past_due');
  });

  it('rejects a malformed event without changing the copy', async () => {
    const ws = workspace(W(2));
    expect(await ws.applyEntitlement({ version: 0, packageId: '', status: 'active', periodStart: 1, periodEnd: 2 } as never)).toBe('invalid');
    expect(await ws.getEntitlement()).toBeNull();
  });

  it('a new period grants credits once and expires what the last period left; an upgrade grants the difference', async () => {
    const ws = W(3);
    const p1 = NOW - DAY;
    await workspace(ws).applyEntitlement(ev({ version: 1, periodStart: p1, periodEnd: p1 + 30 * DAY, aiCredits: 100 }));
    expect((await workspace(ws).aiCredits()).balance).toBe(100);
    await workspace(ws).applyEntitlement(ev({ version: 2, packageId: 'pro', periodStart: p1, periodEnd: p1 + 30 * DAY, aiCredits: 250 }));
    expect((await workspace(ws).aiCredits()).balance).toBe(250); // upgrade: only the 150 difference
    await workspace(ws).applyEntitlement(ev({ version: 3, packageId: 'pro', periodStart: p1 + 30 * DAY, periodEnd: p1 + 60 * DAY, aiCredits: 250 }));
    // the unused 250 of the first period expired, the new 250 landed
    expect((await workspace(ws).aiCredits()).balance).toBe(250);
    expect((await rows<{ ref: string }>(ws, "SELECT ref FROM credit_ledger WHERE kind IN ('grant','expire') ORDER BY id")).map((r) => r.ref)).toEqual([
      `grant:${p1}:basic`, `grant:${p1}:pro`, `expire:${p1}`, `grant:${p1 + 30 * DAY}:pro`,
    ]);
  });
});

describe('entitlements: expiry task', () => {
  it('schedules subscription_expire at period end; running it after the end marks the plan expired', async () => {
    const ws = W(4);
    const end = Date.now() + 5_000;
    await workspace(ws).applyEntitlement(ev({ periodStart: end - 30 * DAY, periodEnd: end }));
    expect(await rows(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'subscription_expire'")).toEqual([{ due_at: end }]);
    await workspace(ws).runDueTasks(end + 1);
    expect((await workspace(ws).getEntitlement())?.status).toBe('expired');
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'subscription_expire'")).toEqual([]);
  });

  it('a renewal that arrived first moves the expiry: the old task finds nothing to expire', async () => {
    const ws = W(5);
    const end = Date.now() + 5_000;
    await workspace(ws).applyEntitlement(ev({ version: 1, periodStart: end - 30 * DAY, periodEnd: end }));
    await workspace(ws).applyEntitlement(ev({ version: 2, periodStart: end, periodEnd: end + 30 * DAY }));
    expect(await rows(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'subscription_expire'")).toEqual([{ due_at: end + 30 * DAY }]);
    await workspace(ws).runDueTasks(end + 1);
    expect((await workspace(ws).getEntitlement())?.status).toBe('active');
  });
});

describe('entitlements: past_due blocks marketing only', () => {
  it.each(['past_due', 'cancelled', 'expired'] as const)('%s: marketing template refused, utility template and text allowed', async (status) => {
    const ws = W(10 + ['past_due', 'cancelled', 'expired'].indexOf(status));
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await seedTemplate(ws, { name: 'upd', category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi' }]) });
    await own(ws);
    const conv = await openChat(ws);
    await workspace(ws).applyEntitlement(ev({ status }));
    const tmpl = (name: string, n: number) => ({ type: 'template' as const, clientId: `00000000-0000-4000-8000-00000000a0${n}`, name, language: 'ar', params: name === 'promo' ? ['a', 'b'] : [] });
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', tmpl('promo', 1))).toMatchObject({ ok: false, reason: 'plan_blocked' });
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', tmpl('upd', 2))).toMatchObject({ ok: true });
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'text', clientId: '00000000-0000-4000-8000-00000000a003', text: 'hello' })).toMatchObject({ ok: true });
  });

  it('a marketing message queued before the plan lapsed fails at claim with plan_blocked', async () => {
    const ws = W(20);
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await own(ws);
    const conv = await openChat(ws);
    const q = await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'template', clientId: '00000000-0000-4000-8000-00000000b001', name: 'promo', language: 'ar', params: ['a', 'b'] });
    expect(q.ok).toBe(true);
    await workspace(ws).applyEntitlement(ev({ status: 'past_due' }));
    expect(await workspace(ws).claimSend((q as unknown as { job: never }).job)).toBe('dropped');
    expect(await rows(ws, "SELECT status, error_reason FROM messages WHERE idempotency_key = 'ui:00000000-0000-4000-8000-00000000b001'")).toEqual([{ status: 'failed', error_reason: 'plan_blocked' }]);
  });

  it('no entitlement on record blocks nothing', async () => {
    const ws = W(21);
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await own(ws);
    const conv = await openChat(ws);
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'template', clientId: '00000000-0000-4000-8000-00000000b002', name: 'promo', language: 'ar', params: ['a', 'b'] })).toMatchObject({ ok: true });
  });
});

describe('entitlements: D1 push and daily reconcile', () => {
  it('pushes a subscription row; the daily reconcile re-sends and never rolls the copy back', async () => {
    const ws = W(30);
    await seedNumber('pn-ent-30', ws);
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO packages (id, name, price_minor, ai_credits, created_at) VALUES ('gold', 'Gold', 0, 300, 1)"),
      env.DB.prepare("INSERT OR REPLACE INTO workspace_subscriptions (workspace_id, package_id, status, period_start, period_end, version, updated_at) VALUES (?, 'gold', 'active', ?, ?, 7, 1)").bind(ws, NOW - DAY, NOW + 29 * DAY),
    ]);
    expect(await pushEntitlement(env, ws)).toBe('applied');
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 7, packageId: 'gold', aiCredits: 300 });
    // the copy is newer than D1 (an event arrived directly): reconcile must not regress it
    await workspace(ws).applyEntitlement(ev({ version: 9, packageId: 'gold', status: 'past_due', aiCredits: 300 }));
    const r = await reconcileEntitlements(env);
    expect(r.failed).toBe(0);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 9, status: 'past_due' });
    expect(await pushEntitlement(env, W(31))).toBe('none');
  });
});
