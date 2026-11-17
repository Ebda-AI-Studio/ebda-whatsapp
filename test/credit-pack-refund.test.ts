import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { holdCredits, settleHold, creditBalance } from '../src/core/ai/credits';
import { applyCreditWebhook, repairCreditOrders, type CreditOrderRow } from '../src/core/billing/credit-packs';
import type { ParsedWebhook } from '../src/core/billing/payments';
import { rows, seedNumber, workspace } from './helpers/workspace';

// WA-PACK-REFUND-1 (#116): a confirmed refund of a credit pack expires the UNUSED part automatically; the spent part is never reversed or taken negative.
const W = (n: number) => `00000000-0000-4000-8000-0000000075${String(n).padStart(2, '0')}`;
const inDo = <T>(ws: string, f: (sql: SqlStorage) => T) => runInDurableObject(workspace(ws), (_i, state) => f(state.storage.sql));
const names = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as { alert?: string; spentCredits?: number; expiredCredits?: number; notCredited?: boolean }; } catch { return {}; } });

const loadRow = async (orderId: string) => (await env.DB.prepare('SELECT order_id, workspace_id, credits, amount_minor, currency, state, created_at, transaction_id FROM credit_orders WHERE order_id = ?').bind(orderId).first<CreditOrderRow>())!;
/** A pending order (checkout opened, not yet credited): what a refund that beats the payment webhook finds. */
async function pendingPack(ws: string, n: number, credits = 100, amount = 23_000): Promise<CreditOrderRow> {
  await seedNumber(`pn-${ws.slice(-8)}`, ws);
  const orderId = `cp_refund_${n}`;
  await env.DB.prepare("INSERT INTO credit_orders (order_id, workspace_id, credits, amount_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, 'EGP', 'pending', 'u', ?)").bind(orderId, ws, credits, amount, Date.now()).run();
  return loadRow(orderId);
}
const payEv = (row: CreditOrderRow, id: string): ParsedWebhook => ({ event: 'pay', status: 'SUCCESS', orderId: row.order_id, transactionId: id, amountMinor: row.amount_minor, currency: 'EGP' });
const ledgerRows = (ws: string) => rows(ws, "SELECT kind, amount FROM credit_ledger ORDER BY id");

async function buyPack(ws: string, n: number, credits = 100, amount = 23_000): Promise<CreditOrderRow> {
  await seedNumber(`pn-${ws.slice(-8)}`, ws); // creates the D1 workspace row
  const orderId = `cp_refund_${n}`;
  await env.DB.prepare("INSERT INTO credit_orders (order_id, workspace_id, credits, amount_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, 'EGP', 'pending', 'u', ?)").bind(orderId, ws, credits, amount, Date.now()).run();
  const row = (await env.DB.prepare('SELECT order_id, workspace_id, credits, amount_minor, currency, state, created_at, transaction_id FROM credit_orders WHERE order_id = ?').bind(orderId).first<CreditOrderRow>())!;
  const pay: ParsedWebhook = { event: 'pay', status: 'SUCCESS', orderId, transactionId: `TX-${n}`, amountMinor: amount, currency: 'EGP' };
  expect(await applyCreditWebhook(env, row, pay, Date.now())).toBe('credited');
  return (await env.DB.prepare('SELECT order_id, workspace_id, credits, amount_minor, currency, state, created_at, transaction_id FROM credit_orders WHERE order_id = ?').bind(orderId).first<CreditOrderRow>())!; // the webhook route loads the row fresh: state 'paid'
}
const refund = (row: CreditOrderRow, id: string, amountMinor = row.amount_minor): ParsedWebhook => ({ event: 'refund', status: 'SUCCESS', orderId: row.order_id, transactionId: id, amountMinor, currency: 'EGP' });
const spend = (ws: string, credits: number) => inDo(ws, (sql) => { holdCredits(sql, 'ai:spend', Date.now(), credits); settleHold(sql, 'ai:spend', Date.now()); });

describe('WA-PACK-REFUND-1 credit pack refund', () => {
  it('buy a pack, spend 30%, refund: the unused 70% expires and the spent 30% is not reversed', async () => {
    const ws = W(1);
    const row = await buyPack(ws, 1);
    await spend(ws, 30);
    const spy = vi.spyOn(console, 'error');
    expect(await applyCreditWebhook(env, row, refund(row, 'RF-1'), Date.now())).toBe('refund_expired');
    expect(await inDo(ws, creditBalance)).toBe(0); // 100 - 30 spent - 70 expired: nothing negative
    expect(await rows(ws, "SELECT kind, amount FROM credit_ledger WHERE kind IN ('expire', 'ai_charge') ORDER BY id")).toEqual([{ kind: 'ai_charge', amount: -30 }, { kind: 'expire', amount: -70 }]);
    expect(names(spy)).toContainEqual(expect.objectContaining({ alert: 'credit_pack_refunded', spentCredits: 30, expiredCredits: 70 }));
  });

  it('a redelivered refund expires nothing more', async () => {
    const ws = W(2);
    const row = await buyPack(ws, 2);
    await spend(ws, 30);
    await applyCreditWebhook(env, row, refund(row, 'RF-2'), Date.now());
    await applyCreditWebhook(env, row, refund(row, 'RF-2'), Date.now());
    expect(await rows(ws, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'expire'")).toEqual([{ n: 1 }]);
  });

  it('a pack that was fully spent expires nothing and never goes negative (the alert still fires for an operator)', async () => {
    const ws = W(3);
    const row = await buyPack(ws, 3);
    await spend(ws, 100);
    const spy = vi.spyOn(console, 'error');
    await applyCreditWebhook(env, row, refund(row, 'RF-3'), Date.now());
    expect(await inDo(ws, creditBalance)).toBe(0);
    expect(names(spy)).toContainEqual(expect.objectContaining({ alert: 'credit_pack_refunded', spentCredits: 100, expiredCredits: 0 }));
  });

  it('a partial refund expires only that share of the pack', async () => {
    const ws = W(4);
    const row = await buyPack(ws, 4);
    await applyCreditWebhook(env, row, refund(row, 'RF-4', 11_500), Date.now());
    expect(await inDo(ws, creditBalance)).toBe(50);
  });

  // WA-PACK-REFUND-1 (review): a refund that lands BEFORE the pack is credited is recorded first (one row per refund) and credits nothing later.
  it('refund then payment webhook: the pack is never credited (balance 0), and the alert says it was not credited', async () => {
    const ws = W(10);
    const row = await pendingPack(ws, 10);
    const spy = vi.spyOn(console, 'error');
    expect(await applyCreditWebhook(env, row, refund(row, 'RF-10'), Date.now())).toBe('refund_recorded');
    expect(await applyCreditWebhook(env, await loadRow(row.order_id), payEv(row, 'TX-10'), Date.now())).toBe('credited');
    expect(await inDo(ws, creditBalance)).toBe(0);
    expect(names(spy)).toContainEqual(expect.objectContaining({ alert: 'credit_pack_refunded', notCredited: true, expiredCredits: 0, spentCredits: 0 }));
    expect((await rows<{ n: number }>(ws, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'expire'"))[0]!.n).toBeLessThanOrEqual(1);
  });

  it('refund then the repair job: nothing is credited', async () => {
    const ws = W(11);
    const row = await pendingPack(ws, 11);
    await env.DB.prepare('UPDATE credit_orders SET created_at = ? WHERE order_id = ?').bind(Date.now() - 20 * 60_000, row.order_id).run();
    await applyCreditWebhook(env, row, refund(row, 'RF-11'), Date.now());
    const provider = { inquire: async () => ({ status: 'SUCCESS' as const, transactionId: 'TX-11', amountMinor: row.amount_minor, currency: 'EGP' }) } as never;
    await repairCreditOrders({ ...env, TOPUPS_ENABLED: 'true' } as never, provider, Date.now());
    expect(await inDo(ws, creditBalance)).toBe(0);
  });

  it('a partial refund before crediting leaves only the remainder', async () => {
    const ws = W(12);
    const row = await pendingPack(ws, 12);
    await applyCreditWebhook(env, row, refund(row, 'RF-12', 11_500), Date.now());
    await applyCreditWebhook(env, await loadRow(row.order_id), payEv(row, 'TX-12'), Date.now());
    expect(await inDo(ws, creditBalance)).toBe(50);
  });

  it('a redelivered refund (before and after crediting) records ONE refund row and expires once', async () => {
    const ws = W(13);
    const row = await pendingPack(ws, 13);
    await applyCreditWebhook(env, row, refund(row, 'RF-13'), Date.now());
    await applyCreditWebhook(env, row, refund(row, 'RF-13'), Date.now());
    await applyCreditWebhook(env, await loadRow(row.order_id), payEv(row, 'TX-13'), Date.now());
    await applyCreditWebhook(env, await loadRow(row.order_id), refund(row, 'RF-13'), Date.now());
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_order_refunds WHERE order_id = ?').bind(row.order_id).first()).toEqual({ n: 1 });
    expect(await inDo(ws, creditBalance)).toBe(0);
    expect((await ledgerRows(ws)).filter((r) => r.kind === 'expire')).toHaveLength(1);
  });

  // WA-PACK-REFUND-1 follow-up: a PAID order whose recorded refund never got its expiry (the step failed after the order was marked paid) is picked up by the repair job.
  it('the repair job expires the unused share of a paid order whose recorded refund has no expiry, once; a second run adds nothing', async () => {
    const ws = W(20);
    const row = await buyPack(ws, 20);
    await spend(ws, 30);
    await env.DB.prepare('INSERT INTO credit_order_refunds (refund_ref, order_id, workspace_id, amount_minor, at) VALUES (?, ?, ?, ?, ?)').bind(`${row.order_id}:RF-20`, row.order_id, ws, row.amount_minor, Date.now()).run(); // recorded, expiry never applied
    expect(await inDo(ws, creditBalance)).toBe(70);
    expect((await repairCreditOrders(env, null, Date.now())).refundsExpired).toBe(1);
    expect(await inDo(ws, creditBalance)).toBe(0);
    expect((await repairCreditOrders(env, null, Date.now())).refundsExpired).toBe(0);
    expect((await ledgerRows(ws)).filter((r) => r.kind === 'expire')).toEqual([{ kind: 'expire', amount: -70 }]);
  });

  it('an order whose refund already has its expiry is untouched by the repair job (even when nothing was left to expire)', async () => {
    const ws = W(21);
    const row = await buyPack(ws, 21);
    await spend(ws, 100);
    await applyCreditWebhook(env, row, refund(row, 'RF-21'), Date.now()); // fully spent: nothing expires, but the refund is applied
    const before = await ledgerRows(ws);
    expect((await repairCreditOrders(env, null, Date.now())).refundsExpired).toBe(0);
    expect(await ledgerRows(ws)).toEqual(before);
  });

  // Security review of the repair job: no backfill exists for `applied_at`, so the job must itself dedupe by the refund's ref (the workspace is the source of truth).
  it('a historical refund whose expiry already exists is not expired again when applied_at is missing (no backfill)', async () => {
    const ws = W(22);
    const row = await buyPack(ws, 22);
    await spend(ws, 30);
    await applyCreditWebhook(env, row, refund(row, 'RF-22'), Date.now()); // expires 70
    await env.DB.prepare('UPDATE credit_order_refunds SET applied_at = NULL WHERE order_id = ?').bind(row.order_id).run(); // as if migration 0037 never stamped it
    await workspace(ws).postAiCredits({ kind: 'purchase', amount: 50, ref: 'later-purchase-22' }); // credits that a second expiry would wrongly take
    expect((await repairCreditOrders(env, null, Date.now())).refundsExpired).toBe(0);
    expect(await inDo(ws, creditBalance)).toBe(50);
    expect((await ledgerRows(ws)).filter((r) => r.kind === 'expire')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT applied_at IS NOT NULL AS done FROM credit_order_refunds WHERE order_id = ?').bind(row.order_id).first()).toEqual({ done: 1 }); // stamped by the check
  });

  it('a refund that expired nothing (pack fully spent) is a no-op on a re-run, even after the balance grew', async () => {
    const ws = W(23);
    const row = await buyPack(ws, 23);
    await spend(ws, 100);
    await applyCreditWebhook(env, row, refund(row, 'RF-23'), Date.now()); // nothing unused: expires 0
    await env.DB.prepare('UPDATE credit_order_refunds SET applied_at = NULL WHERE order_id = ?').bind(row.order_id).run();
    await workspace(ws).postAiCredits({ kind: 'purchase', amount: 50, ref: 'later-purchase-23' });
    await repairCreditOrders(env, null, Date.now());
    expect(await inDo(ws, creditBalance)).toBe(50);
    expect((await ledgerRows(ws)).filter((r) => r.kind === 'expire')).toHaveLength(0);
  });
});
