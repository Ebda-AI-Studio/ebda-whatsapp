import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { suspendWorkspace } from '../src/core/ops/kill-switch';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, jobOf, ledger, nowS, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { workspace } from './helpers/workspace';

useApiKey();
// WA-DEBT-1 (#113): debt past 2x the overdraft limit suspends the workspace (tag wallet_debt); the adjustment itself is always recorded in full.
const alertNames = () => vi.spyOn(console, 'error');
const names = (spy: ReturnType<typeof alertNames>) => spy.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } }).filter(Boolean);
const d1 = (ws: string) => env.DB.prepare('SELECT suspended_at, suspended_reason FROM workspaces WHERE id = ?').bind(ws).first<{ suspended_at: number | null; suspended_reason: string | null }>();
const LIMIT = 100; // piasters; 2x = 200

async function debtor(ws: string) {
  await setupBilling(ws, { settings: { limit: LIMIT } });
  await apiFor(ws); // creates the D1 workspace row
  const conv = await chat(ws);
  const job = jobOf(await queueTemplate(ws, conv, 'UTILITY')); // 100 piasters, may use the overdraft
  await sendOut(ws, job, wamidOf(`debt-${ws.slice(-4)}`));
  await status(ws, wamidOf(`debt-${ws.slice(-4)}`), 'delivered', nowS(), pricing('utility'));
}

describe('WA-DEBT-1 wallet debt past twice the overdraft limit', () => {
  it('a delivery charge plus an adjustment beyond 2x the limit records the adjustment, suspends, mirrors to D1 and alerts', async () => {
    const ws = W(1300);
    await debtor(ws);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(-100);
    expect(await workspace(ws).suspended()).toBe(false);
    const spy = alertNames();
    const r = await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-1', actor: 'meta', note: 'category change' });
    expect(r).toMatchObject({ ok: true, balance: -250 }); // recorded in full, never refused
    expect((await ledger(ws)).at(-1)).toMatchObject({ kind: 'meta_adjust', amount_minor: -150, balance_after: -250 });
    expect(await workspace(ws).suspended()).toBe(true);
    expect(names(spy)).toContain('wallet_debt_suspended');
    await workspace(ws).runDueTasks();
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'wallet_debt' });
  });

  it('debt within 2x the limit does not suspend', async () => {
    const ws = W(1301);
    await debtor(ws);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -90, ref: 'adj:debt-2', actor: 'meta', note: 'small' });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(-190);
    expect(await workspace(ws).suspended()).toBe(false);
  });

  it('a top-up that brings the balance back inside the overdraft lifts OUR suspension, in the workspace and in D1', async () => {
    const ws = W(1302);
    await debtor(ws);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-3', actor: 'meta', note: 'big' });
    await workspace(ws).runDueTasks();
    await fund(ws, 120); // -250 -> -130: still past the limit, stays suspended
    expect(await workspace(ws).suspended()).toBe(true);
    await fund(ws, 100); // -30: inside the overdraft
    expect(await workspace(ws).suspended()).toBe(false);
    await workspace(ws).runDueTasks();
    expect(await d1(ws)).toEqual({ suspended_at: null, suspended_reason: null });
  });

  it('never lifts an operator suspension, and never overwrites one with ours', async () => {
    const ws = W(1303);
    await debtor(ws);
    await suspendWorkspace(env, { actor: 'op', workspaceId: ws, reason: 'abuse report' });
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-4', actor: 'meta', note: 'big' });
    await fund(ws, 1000);
    await workspace(ws).runDueTasks();
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'abuse report' });
  });
});
