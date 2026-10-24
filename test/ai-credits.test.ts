import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { HOLD_TTL_MS, heartbeatHold, creditBalance, creditsAvailable, expireGrant, grantCredits, holdCredits, postCredit, releaseHold, settleHold, upgradeGrant } from '../src/core/ai/credits';
import { backupPrefix } from '../src/core/backup';
import { rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000053${String(n).padStart(2, '0')}`;
const inDo = <T>(ws: string, f: (sql: SqlStorage, tx: <R>(g: () => R) => R) => T) => runInDurableObject(workspace(ws), (_i, state) => f(state.storage.sql, (g) => state.storage.transactionSync(g)));
const T0 = 1_800_000_000_000;

describe('credit ledger', () => {
  it('starts at zero; a grant is once per (period, package); balance_after follows the rows', async () => {
    const ws = W(1);
    await inDo(ws, (sql) => {
      expect(creditBalance(sql)).toBe(0);
      expect(grantCredits(sql, { periodStart: T0, packageId: 'basic', credits: 100, now: T0 })).toEqual({ ok: true, balance: 100 });
      expect(grantCredits(sql, { periodStart: T0, packageId: 'basic', credits: 100, now: T0 + 1 })).toEqual({ ok: false, reason: 'duplicate' });
      expect(postCredit(sql, { kind: 'purchase', amount: 20, ref: 'kashier:tx-1', now: T0 })).toEqual({ ok: true, balance: 120 });
      expect(postCredit(sql, { kind: 'purchase', amount: 0, ref: 'x', now: T0 })).toEqual({ ok: false, reason: 'invalid' });
    });
    expect(await rows(ws, 'SELECT kind, amount, balance_after, ref FROM credit_ledger ORDER BY id')).toEqual([
      { kind: 'grant', amount: 100, balance_after: 100, ref: `grant:${T0}:basic` },
      { kind: 'purchase', amount: 20, balance_after: 120, ref: 'kashier:tx-1' },
    ]);
  });

  it('is append-only: update and delete are refused by the database, for the ledger and for holds', async () => {
    const ws = W(2);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 5, now: T0 });
      holdCredits(sql, 'ai:1', T0);
      expect(() => sql.exec('UPDATE credit_ledger SET amount = 999')).toThrow(/append-only/);
      expect(() => sql.exec('DELETE FROM credit_ledger')).toThrow(/append-only/);
      expect(() => sql.exec('DELETE FROM credit_holds')).toThrow(/never deleted/);
      expect(creditBalance(sql)).toBe(5);
    });
  });

  it('hold, settle, release: available = balance - held; one charge per ref', async () => {
    const ws = W(3);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 2, now: T0 });
      expect(holdCredits(sql, 'ai:1', T0)).toBe('held');
      expect(creditsAvailable(sql, T0)).toBe(1);
      expect(holdCredits(sql, 'ai:2', T0)).toBe('held');
      expect(holdCredits(sql, 'ai:3', T0)).toBe('insufficient'); // two held of two
      expect(creditBalance(sql)).toBe(2); // holds do not touch the ledger
      settleHold(sql, 'ai:1', T0);
      settleHold(sql, 'ai:1', T0); // idempotent
      expect(creditBalance(sql)).toBe(1);
      releaseHold(sql, 'ai:2', T0);
      expect(creditsAvailable(sql, T0)).toBe(1);
      expect(holdCredits(sql, 'ai:1', T0)).toBe('already_charged'); // a replayed turn finds its own charge
      settleHold(sql, 'ai:2', T0); // released holds never charge
      expect(creditBalance(sql)).toBe(1);
    });
    expect((await rows(ws, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'ai_charge'"))[0]).toEqual({ n: 1 });
  });

  it('a hold whose turn crashed frees itself after the TTL (the row stays)', async () => {
    const ws = W(4);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 1, now: T0 });
      expect(holdCredits(sql, 'ai:1', T0)).toBe('held');
      expect(holdCredits(sql, 'ai:2', T0 + HOLD_TTL_MS - 1)).toBe('insufficient');
      expect(holdCredits(sql, 'ai:2', T0 + HOLD_TTL_MS + 1)).toBe('held');
    });
    expect(await rows(ws, 'SELECT ref, state FROM credit_holds ORDER BY ref')).toEqual([{ ref: 'ai:1', state: 'expired' }, { ref: 'ai:2', state: 'held' }]);
  });

  it('settling a hold that expired mid-turn re-checks the credits: another call may have taken them (no overdraw, nothing posted, alerted)', async () => {
    const ws = W(9);
    const log: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 1, now: T0 });
      expect(holdCredits(sql, 'ai:slow', T0)).toBe('held');
      const later = T0 + HOLD_TTL_MS + 5;
      expect(holdCredits(sql, 'ai:other', later)).toBe('held'); // the slow turn's hold lapsed, the credit was re-offered
      settleHold(sql, 'ai:other', later);
      expect(creditBalance(sql)).toBe(0);
      expect(settleHold(sql, 'ai:slow', later + 1)).toBe('refused');
      expect(creditBalance(sql)).toBe(0); // never negative
    });
    spy.mockRestore();
    expect(log.join(' ')).toContain('ai_overdraw_refused');
    expect(await rows(ws, "SELECT ref FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ ref: 'ai:other' }]);
  });

  it('an expired hold whose credit is still free is charged normally', async () => {
    const ws = W(10);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 1, now: T0 });
      holdCredits(sql, 'ai:slow', T0);
      expect(settleHold(sql, 'ai:slow', T0 + HOLD_TTL_MS + 5)).toBe('charged');
      expect(creditBalance(sql)).toBe(0);
    });
  });

  it('a heartbeat keeps a long turn\'s hold alive: nobody else can take its credit', async () => {
    const ws = W(11);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'p', credits: 1, now: T0 });
      holdCredits(sql, 'ai:long', T0);
      let t = T0;
      for (let i = 0; i < 5; i++) { t += HOLD_TTL_MS - 1000; heartbeatHold(sql, 'ai:long', t); }
      expect(holdCredits(sql, 'ai:other', t + 1)).toBe('insufficient');
      expect(settleHold(sql, 'ai:long', t + 2)).toBe('charged');
      heartbeatHold(sql, 'ai:long', t + 3); // no effect on a settled hold
      expect(creditBalance(sql)).toBe(0);
    });
  });

  it('an upgrade grants the difference; expiry removes only unused GRANTED credits, purchased ones roll over', async () => {
    const ws = W(5);
    await inDo(ws, (sql) => {
      grantCredits(sql, { periodStart: T0, packageId: 'basic', credits: 100, now: T0 });
      expect(upgradeGrant(sql, { periodStart: T0, toPackage: 'pro', toCredits: 300, now: T0 + 10 })).toEqual({ ok: true, balance: 300 });
      expect(upgradeGrant(sql, { periodStart: T0, toPackage: 'pro', toCredits: 300, now: T0 + 11 }).ok).toBe(false); // nothing left to top up
      postCredit(sql, { kind: 'purchase', amount: 50, ref: 'buy:1', now: T0 + 20 });
      for (let i = 0; i < 40; i++) { holdCredits(sql, `ai:${i}`, T0 + 30); settleHold(sql, `ai:${i}`, T0 + 30); }
      expect(creditBalance(sql)).toBe(310);
      expect(expireGrant(sql, { periodStart: T0, now: T0 + 100 })).toBe(260); // 300 granted - 40 used
      expect(expireGrant(sql, { periodStart: T0, now: T0 + 101 })).toBe(0); // once
      expect(creditBalance(sql)).toBe(50);
    });
  });

  it('DO methods return results; an operator adjustment needs an actor and a reason', async () => {
    const stub = workspace(W(6));
    expect(await stub.grantAiCredits({ periodStart: T0, packageId: 'p', credits: 10 })).toEqual({ ok: true, balance: 10 });
    expect(await stub.postAiCredits({ kind: 'adjustment', amount: -3, ref: 'adj:1' })).toEqual({ ok: false, reason: 'actor_and_note_required' });
    expect(await stub.postAiCredits({ kind: 'adjustment', amount: -3, ref: 'adj:1', actor: 'u1', note: 'goodwill reversal' })).toEqual({ ok: true, balance: 7 });
    expect(await stub.aiCredits()).toEqual({ balance: 7, available: 7 });
  });

  it('is in the backup and comes back on restore', async () => {
    const a = W(7);
    const b = W(8);
    await workspace(a).grantAiCredits({ periodStart: T0, packageId: 'p', credits: 42 });
    await workspace(a).exportSnapshot('2026-10-25');
    const res = await workspace(b).importSnapshot(backupPrefix(a, '2026-10-25'));
    expect(res.ok).toBe(true);
    expect((await workspace(b).aiCredits()).balance).toBe(42);
  });
});
