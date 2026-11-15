import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { holdCredits, settleHold, creditBalance } from '../src/core/ai/credits';
import { applyCreditWebhook, type CreditOrderRow } from '../src/core/billing/credit-packs';
import type { ParsedWebhook } from '../src/core/billing/payments';
import { rows, seedNumber, workspace } from './helpers/workspace';

// WA-PACK-REFUND-1 (#116): a confirmed refund of a credit pack expires the UNUSED part automatically; the spent part is never reversed or taken negative.
const W = (n: number) => `00000000-0000-4000-8000-0000000075${String(n).padStart(2, '0')}`;
const inDo = <T>(ws: string, f: (sql: SqlStorage) => T) => runInDurableObject(workspace(ws), (_i, state) => f(state.storage.sql));
const names = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as { alert?: string; spentCredits?: number; expiredCredits?: number }; } catch { return {}; } });

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
});
