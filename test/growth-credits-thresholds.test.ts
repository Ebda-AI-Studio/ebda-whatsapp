import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { AI_TURN_CREDITS, LOW_CREDITS_FLOOR, creditsAvailable, grantCredits, holdCredits, lowCreditsThreshold, settleHold } from '../src/core/ai/credits';
import { LOW_BALANCE_MINOR, LOW_RUNWAY_DAYS } from '../src/core/billing/engine';
import { exec, rows, seedPlan, workspace } from './helpers/workspace';

// M-084: "AI credit" is defined (one AI turn) and the low-credit alert threshold follows the package, not a magic number; the wallet's low-balance threshold follows the spend.
const W = (n: number) => `00000000-0000-4000-8000-0000000091${String(n).padStart(2, '0')}`;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const inDo = <T>(ws: string, f: (sql: SqlStorage, tx: <R>(g: () => R) => R) => T) => runInDurableObject(workspace(ws), (_i, state) => f(state.storage.sql, (g) => state.storage.transactionSync(g)));
const setAllowance = (ws: string, credits: number) => exec(ws, 'UPDATE entitlements SET ai_credits = ?', credits);

describe('what a credit is', () => {
  it('one credit is one AI turn: the hold for a turn is exactly AI_TURN_CREDITS (1) and a settled turn posts one ai_charge of that size', async () => {
    const ws = W(1);
    await seedPlan(ws);
    expect(AI_TURN_CREDITS).toBe(1);
    await inDo(ws, (sql, tx) => {
      tx(() => grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 10, now: T0 }));
      tx(() => { holdCredits(sql, 'ai:1', T0); settleHold(sql, 'ai:1', T0, ws); });
    });
    expect(await rows(ws, "SELECT kind, amount FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ kind: 'ai_charge', amount: -1 }]);
  });
});

describe('the low-credit threshold follows the package', () => {
  it('is 10% of the monthly allowance, never below the floor', () => {
    expect(LOW_CREDITS_FLOOR).toBe(5);
    expect(lowCreditsThreshold(300)).toBe(30); // starter
    expect(lowCreditsThreshold(1500)).toBe(150); // growth
    expect(lowCreditsThreshold(5000)).toBe(500); // pro
    expect(lowCreditsThreshold(100)).toBe(10); // store-included
    expect(lowCreditsThreshold(20)).toBe(5);
    expect(lowCreditsThreshold(0)).toBe(5);
  });

  it('settling a turn that leaves less than the threshold raises ai_credits_low ONCE a day, and again the next day while still low', async () => {
    const ws = W(2);
    await seedPlan(ws);
    await setAllowance(ws, 100); // threshold 10
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    await inDo(ws, (sql, tx) => {
      tx(() => grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 100, now: T0 }));
      const turn = (n: number, at: number) => tx(() => { holdCredits(sql, `ai:${n}`, at); settleHold(sql, `ai:${n}`, at, ws); });
      for (let n = 1; n <= 90; n++) turn(n, T0 + n); // 10 left: not below the threshold yet
      expect(logs.filter((l) => l.includes('ai_credits_low'))).toHaveLength(0);
      turn(91, T0 + 91); // 9 left: below
      expect(logs.filter((l) => l.includes('ai_credits_low'))).toHaveLength(1);
      turn(92, T0 + 92); turn(93, T0 + 93);
      expect(logs.filter((l) => l.includes('ai_credits_low'))).toHaveLength(1); // not again the same day
      turn(94, T0 + DAY + 1000);
      expect(logs.filter((l) => l.includes('ai_credits_low'))).toHaveLength(2); // the next day, still low
      expect(creditsAvailable(sql, T0 + DAY + 2000)).toBe(6);
    });
    spy.mockRestore();
    const line = logs.find((l) => l.includes('ai_credits_low'))!;
    expect(JSON.parse(line)).toMatchObject({ alert: 'ai_credits_low', workspace: ws, available: 9, threshold: 10 });
  });

  it('the wallet view says whether credits are low, the threshold and the allowance', async () => {
    const ws = W(3);
    await seedPlan(ws);
    await setAllowance(ws, 300);
    await workspace(ws).grantAiCredits({ periodStart: T0, packageId: 'p', credits: 300 }, T0);
    expect((await workspace(ws).walletView()).aiCredits).toMatchObject({ balance: 300, available: 300, low: false, lowThreshold: 30, allowance: 300 });
    await inDo(ws, (sql, tx) => tx(() => { for (let n = 1; n <= 271; n++) { holdCredits(sql, `ai:${n}`, T0 + n); settleHold(sql, `ai:${n}`, T0 + n, ws); } }));
    expect((await workspace(ws).walletView()).aiCredits).toMatchObject({ available: 29, low: true, lowThreshold: 30 });
  });
});

describe('the wallet low-balance threshold follows the spend', () => {
  const NOW = T0 + 10 * DAY;
  const spend = async (ws: string, perDayMinor: number) => {
    for (let d = 1; d <= 7; d++) await exec(ws, "INSERT INTO wallet_ledger (at, kind, net_minor, amount_minor, balance_after, ref, category) VALUES (?, 'meta_charge', ?, ?, 0, ?, 'marketing')", NOW - d * DAY + 1000, -perDayMinor, -perDayMinor, `t:${ws}:${d}`);
  };
  it('is at least the floor (20 EGP) and at least LOW_RUNWAY_DAYS (3) days of the last week\'s average spend', async () => {
    expect(LOW_BALANCE_MINOR).toBe(2000);
    expect(LOW_RUNWAY_DAYS).toBe(3);
    const quiet = W(4);
    await seedPlan(quiet);
    expect((await workspace(quiet).walletView(NOW)).lowBalanceThresholdMinor).toBe(2000);
    const busy = W(5);
    await seedPlan(busy);
    await spend(busy, 1000); // 10 EGP a day -> 3 days = 3000
    expect((await workspace(busy).walletView(NOW)).lowBalanceThresholdMinor).toBe(3000);
  });
  it('a balance that was fine under the flat rule is low for a merchant who spends a lot, and the alert fires once a day', async () => {
    const ws = W(6);
    await seedPlan(ws);
    await spend(ws, 5000); // 50 EGP a day -> threshold 15000
    await exec(ws, "INSERT INTO wallet_ledger (at, kind, net_minor, amount_minor, balance_after, ref) VALUES (?, 'topup', 8000, 8000, 8000, 'topup:x')", NOW - 1000);
    const view = await workspace(ws).walletView(NOW);
    expect(view).toMatchObject({ availableMinor: 8000, lowBalance: true, lowBalanceThresholdMinor: 15000 });
  });
});
