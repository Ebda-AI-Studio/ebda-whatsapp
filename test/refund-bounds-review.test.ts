import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileRefundBounds } from '../src/core/billing/refund-excess';
import { storeId as W0 } from './helpers/api';
import { seedNumber } from './helpers/workspace';

afterEach(() => vi.restoreAllMocks());
const ws = W0(9790);

describe('item 15: the daily refund-bound reconcile does not stop early', () => {
  it('120 UNCLAMPED rows written directly (a writer that missed the clamp) are ALL reported, across both tables and past the old LIMIT 50', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedNumber(`pn-rb-${ws.slice(-6)}`, ws);
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 70; i++) stmts.push(env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at, refunded_minor) VALUES (?, ?, 1000, 1000, 'paid', 'u', 1, 1500)").bind(`rb-t-${String(i).padStart(3, '0')}`, ws));
    for (let i = 0; i < 50; i++) stmts.push(env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, status, created_by, created_at, refunded_minor) VALUES (?, ?, 'test-plan', 1000, 'paid', 'u', 1, 1700)").bind(`rb-p-${String(i).padStart(3, '0')}`, ws));
    await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('test-plan', 'Test plan', 0, 0, 1, 0)").run();
    await env.DB.batch(stmts);
    const res = await reconcileRefundBounds(env);
    expect(res.over).toBeGreaterThanOrEqual(120);
    const mine = spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as { alert?: string; orderId?: string; unclamped?: boolean }; } catch { return {}; } }).filter((a) => a.alert === 'refund_exceeds_charge' && a.unclamped && a.orderId?.startsWith('rb-'));
    expect(new Set(mine.map((a) => a.orderId)).size).toBe(120);
  });

  it('a clean table reports nothing', async () => {
    await env.DB.prepare('UPDATE topups SET refunded_minor = amount_minor WHERE refunded_minor > amount_minor').run();
    await env.DB.prepare('UPDATE package_orders SET refunded_minor = amount_minor WHERE refunded_minor > amount_minor').run();
    expect((await reconcileRefundBounds(env)).over).toBe(0);
  });
});
