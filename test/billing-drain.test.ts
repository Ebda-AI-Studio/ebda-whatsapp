import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainKeyset } from '../src/core/billing/drain';
import { overdueInstapay, repairInstapay } from '../src/core/billing/instapay';
import { sweepAbandonedRefunds } from '../src/core/billing/card-refunds';
import { reconfirmUnconfirmed } from '../src/core/billing/topups';
import { testKashier } from './helpers/kashier';
import { storeId as W0 } from './helpers/api';
import { seedNumber } from './helpers/workspace';

const W = (n: number) => W0(9900 + n);
const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());
const alertNames = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });

describe('drainKeyset: every page until empty, never the same rows twice, bounded', () => {
  const data = Array.from({ length: 23 }, (_, i) => ({ id: i + 1 }));
  const page = (size: number) => async (after: number | null) => data.filter((r) => r.id > (after ?? 0)).slice(0, size);

  it('handles all 23 rows in pages of 5 (not just the first page)', async () => {
    const seen: number[] = [];
    const r = await drainKeyset({ name: 't', pageSize: 5, page: page(5), cursorOf: (x) => x.id, handle: async (x) => { seen.push(x.id); } });
    expect(seen).toEqual(data.map((d) => d.id));
    expect(r).toEqual({ handled: 23, capped: false });
  });

  it('rows that keep failing are visited once per pass: the cursor moves on, the pass does not loop on them', async () => {
    let calls = 0;
    const r = await drainKeyset({ name: 't', pageSize: 5, page: page(5), cursorOf: (x) => x.id, handle: async () => { calls++; throw new Error('always fails'); } });
    expect(calls).toBe(23);
    expect(r.capped).toBe(false);
  });

  it('is bounded: after maxBatches it stops, says so (P1 billing_pass_backlog) and the next pass continues', async () => {
    const spy = vi.spyOn(console, 'error');
    const seen: number[] = [];
    const r = await drainKeyset({ name: 'demo_pass', pageSize: 5, maxBatches: 2, page: page(5), cursorOf: (x) => x.id, handle: async (x) => { seen.push(x.id); } });
    expect(r).toEqual({ handled: 10, capped: true });
    expect(alertNames(spy)).toContain('billing_pass_backlog');
  });

  it('an exact multiple of the page size ends cleanly on the empty page', async () => {
    const r = await drainKeyset({ name: 't', pageSize: 23, page: page(23), cursorOf: (x) => x.id, handle: async () => undefined });
    expect(r).toEqual({ handled: 23, capped: false });
  });
});

describe('the daily passes drain (M-178): more rows than one page are all handled', () => {
  beforeEach(async () => { vi.restoreAllMocks(); });

  it('overdueInstapay alerts every overdue proof, not the first page', async () => {
    const ws = W(1);
    await seedNumber(`pn-dr-${ws.slice(-6)}`, ws);
    const old = Date.now() - 10 * DAY;
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, state, created_by, created_at, expires_at, proof_at) VALUES (?, ?, ?, 'topup', 20000, 'under_review', 'm', ?, ?, ?)").bind(`od-${i}`, `WA-OVERDUE${i}`, ws, old, old + DAY, old + i).run();
    }
    const r = await overdueInstapay(env, Date.now(), { page: 3 });
    expect(r.alerted).toBeGreaterThanOrEqual(8);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM instapay_requests WHERE id LIKE 'od-%' AND overdue_alerted_at IS NOT NULL").first<{ n: number }>())!.n).toBe(8);
  });

  it('repairInstapay visits every confirmed-ungranted request (a failing grant is reported once each, and does not stall the pass)', async () => {
    const ws = W(2);
    await seedNumber(`pn-dr-${ws.slice(-6)}`, ws);
    const old = Date.now() - 3 * DAY;
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, state, created_by, created_at, expires_at, decided_at) VALUES (?, ?, ?, 'topup', 20000, 'confirmed', 'm', ?, ?, ?)").bind(`rp-${i}`, `WA-REPAIR${i}`, ws, old, old + DAY, old + i).run();
    }
    await repairInstapay(env, Date.now(), { page: 3 });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'instapay_repair_failed' AND reason LIKE 'rp-%'").first<{ n: number }>())!.n).toBe(8);
  });

  it('sweepAbandonedRefunds works the whole backlog in one pass', async () => {
    const ws = W(3);
    await seedNumber(`pn-dr-${ws.slice(-6)}`, ws);
    const old = Date.now() - 3 * DAY;
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, state, requested_by, created_at, abandoned_at) VALUES (?, ?, 6000, 'abandoned', 'm', ?, ?)").bind(`ab-${i}`, ws, old, old + i).run();
    }
    const r = await sweepAbandonedRefunds(env, Date.now(), 3);
    expect(r.checked).toBe(8);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM refund_requests WHERE id LIKE 'ab-%' AND swept_at IS NOT NULL").first<{ n: number }>())!.n).toBe(8);
  });

  it('reconfirmUnconfirmed handles every due kept webhook', async () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare("INSERT INTO unconfirmed_webhooks (event_key, order_id, raw_body, signature, first_seen, last_seen, attempts, next_attempt_at, status) VALUES (?, ?, 'not json', 'bad', ?, ?, 0, ?, 'open')").bind(`uw-${i}`, `o-${i}`, now - DAY, now - DAY, now - 1000 - i).run();
    }
    await reconfirmUnconfirmed(env, testKashier(), now, { page: 3 });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM unconfirmed_webhooks WHERE event_key LIKE 'uw-%' AND status = 'open' AND next_attempt_at <= ?").bind(now).first<{ n: number }>())!.n).toBe(0);
  });
});
