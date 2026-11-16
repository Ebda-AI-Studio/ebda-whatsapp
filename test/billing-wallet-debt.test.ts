import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { suspendWorkspace, unsuspendWorkspace } from '../src/core/ops/kill-switch';
import { abuseSuspended } from '../src/core/ops/offboarding';
import { makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { deliver, iso, storeEvent } from './helpers/store-link';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, jobOf, ledger, nowS, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { exec, own, rows, workspace } from './helpers/workspace';

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

  it('an operator suspension over a debt suspension is audited, replaces the D1 reason and counts as abuse; paying the debt does not lift it', async () => {
    const ws = W(1303);
    await debtor(ws);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-4', actor: 'meta', note: 'big' });
    await workspace(ws).runDueTasks();
    expect(await d1(ws)).toMatchObject({ suspended_reason: 'wallet_debt' });
    expect(await abuseSuspended(env, ws)).toBe(false); // a debt suspension is a money block, not abuse evidence
    await suspendWorkspace(env, { actor: 'op', workspaceId: ws, reason: 'abuse report' });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM operator_actions WHERE workspace_id = ? AND action = 'suspend'").bind(ws).first<{ n: number }>())!.n).toBe(1);
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'abuse report' });
    expect(await abuseSuspended(env, ws)).toBe(true);
    await fund(ws, 1000); // debt paid: only the debt flag clears
    await workspace(ws).runDueTasks();
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'abuse report' });
    await unsuspendWorkspace(env, { actor: 'op', workspaceId: ws, reason: 'resolved with the owner' });
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await d1(ws)).toEqual({ suspended_at: null, suspended_reason: null });
  });

  it('debt + Store hold: each reason clears on its own, in the workspace and in D1', async () => {
    const ws = W(1304);
    await debtor(ws);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-5', actor: 'meta', note: 'big' });
    await workspace(ws).runDueTasks();
    await deliver([storeEvent(ws, 'store.suspended', { reason: 'unpaid', at: iso(Date.now()) })]);
    expect(await d1(ws)).toMatchObject({ suspended_reason: 'store_suspended' }); // the Store tag outranks the debt tag
    await fund(ws, 1000); // the debt is paid while the Store hold is on
    await workspace(ws).runDueTasks();
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'store_suspended' });
    await deliver([storeEvent(ws, 'store.reactivated', { at: iso(Date.now() + 1000) })]);
    expect(await workspace(ws).suspended()).toBe(false); // the Store reactivated and nothing else holds: fully unlocked, no stale wallet_debt
    expect(await d1(ws)).toEqual({ suspended_at: null, suspended_reason: null });
  });

  it('a Store reactivation while the debt is still on stays suspended with reason wallet_debt; paying the debt alone then unlocks', async () => {
    const ws = W(1305);
    await debtor(ws);
    await deliver([storeEvent(ws, 'store.suspended', { reason: 'unpaid', at: iso(Date.now()) })]);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-6', actor: 'meta', note: 'big' }); // the debt trips DURING the hold
    await workspace(ws).runDueTasks();
    await deliver([storeEvent(ws, 'store.reactivated', { at: iso(Date.now() + 1000) })]);
    expect(await workspace(ws).suspended()).toBe(true);
    expect(await d1(ws)).toEqual({ suspended_at: expect.any(Number), suspended_reason: 'wallet_debt' });
    await fund(ws, 1000);
    await workspace(ws).runDueTasks();
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await d1(ws)).toEqual({ suspended_at: null, suspended_reason: null });
  });

  it('a debt suspension PAUSES running campaigns (wallet_empty) and fails no audience row; a top-up resumes nothing', async () => {
    const ws = W(1306);
    await debtor(ws);
    await own(ws);
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const c = await makeCampaign(ws);
    await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", c.id);
    await workspace(ws).postWallet({ kind: 'meta_adjust', netMinor: -150, ref: 'adj:debt-7', actor: 'meta', note: 'big' });
    await workspace(ws).runDueTasks();
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns WHERE id = ?', c.id)).toEqual([{ status: 'paused', pause_reason: 'wallet_empty' }]);
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE status = 'failed'")).toEqual([{ n: 0 }]);
    await fund(ws, 1000);
    await workspace(ws).runDueTasks();
    expect((await rows<{ status: string }>(ws, 'SELECT status FROM campaigns WHERE id = ?', c.id))[0]!.status).toBe('paused');
  });
});
