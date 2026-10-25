import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cairoDay, eraseFunnelMarkers, funnelRollup, recordFunnelStep } from '../src/core/bot-funnel';
import { workspace } from './helpers/workspace';

const WA = '201001234567';
const WA2 = '201009876543';
const T = Date.UTC(2026, 5, 10, 9, 0); // 2026-06-10 12:00 in Cairo (summer time)
const DAY = 86_400_000;

/** Runs `f` inside a fresh workspace's DO with its SQL. */
const inDo = <R>(ws: string, f: (sql: SqlStorage) => R | Promise<R>) => runInDurableObject(workspace(ws), (_i, s) => f(s.storage.sql));
const all = <R = Record<string, unknown>>(sql: SqlStorage, q: string, ...p: unknown[]) => sql.exec(q, ...(p as SqlStorageValue[])).toArray() as R[];

describe('recording', () => {
  it('counts one customer once per step per day, however often the step repeats', async () => {
    await inDo('fn-r1', async (sql) => {
      expect(await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T })).toBe(true);
      expect(await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T + 60_000 })).toBe(false);
      expect(await recordFunnelStep(sql, { step: 'cart', waId: WA, now: T })).toBe(true);
      expect(await recordFunnelStep(sql, { step: 'browse', waId: WA2, now: T })).toBe(true);
      expect(all(sql, 'SELECT step, count(*) AS n FROM bot_funnel_markers GROUP BY step ORDER BY step')).toEqual([{ step: 'browse', n: 2 }, { step: 'cart', n: 1 }]);
    });
  });

  it('holds no phone number, wa id or message text anywhere, and the token differs between days (no join across days)', async () => {
    await inDo('fn-r2', async (sql) => {
      await recordFunnelStep(sql, { step: 'conversation', waId: WA, now: T });
      await recordFunnelStep(sql, { step: 'conversation', waId: WA, now: T + DAY });
      const toks = all<{ day: string; token: string }>(sql, 'SELECT day, token FROM bot_funnel_markers ORDER BY day');
      expect(toks).toHaveLength(2);
      expect(toks[0]!.token).not.toBe(toks[1]!.token);
      const dump = JSON.stringify([all(sql, 'SELECT * FROM bot_funnel_markers'), all(sql, 'SELECT * FROM bot_funnel_daily'), all(sql, 'SELECT * FROM bot_funnel_salt')]);
      expect(dump).not.toContain(WA);
      expect(dump).not.toContain(WA.slice(2));
    });
  });

  it('a skipped record (the customer was erased meanwhile) writes nothing', async () => {
    await inDo('fn-r3', async (sql) => {
      expect(await recordFunnelStep(sql, { step: 'order', waId: WA, now: T, skip: () => true })).toBe(false);
      expect(all(sql, 'SELECT * FROM bot_funnel_markers')).toEqual([]);
      expect(all(sql, 'SELECT * FROM scheduled_tasks WHERE kind = ?', 'funnel_rollup')).toEqual([]);
    });
  });

  it('schedules ONE rollup, due at 01:00 Cairo the next day', async () => {
    await inDo('fn-r4', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T });
      await recordFunnelStep(sql, { step: 'cart', waId: WA2, now: T });
      expect(all(sql, "SELECT due_at FROM scheduled_tasks WHERE kind = 'funnel_rollup'")).toEqual([{ due_at: Date.UTC(2026, 5, 10, 22, 0) }]); // 01:00 EEST on 06-11
    });
  });
});

describe('the Cairo day', () => {
  it('follows the wall clock across both clock changes', () => {
    // spring forward: Fri 2026-04-24, 00:00 -> 01:00 (UTC+2 -> UTC+3 at 22:00Z)
    expect(cairoDay(Date.UTC(2026, 3, 23, 21, 59))).toBe('2026-04-23');
    expect(cairoDay(Date.UTC(2026, 3, 23, 22, 0))).toBe('2026-04-24');
    // fall back: Thu 2026-10-29, 24:00 -> 23:00 (UTC+3 -> UTC+2 at 21:00Z); the repeated hour is one day
    expect(cairoDay(Date.UTC(2026, 9, 29, 20, 30))).toBe('2026-10-29');
    expect(cairoDay(Date.UTC(2026, 9, 29, 21, 30))).toBe('2026-10-29');
    expect(cairoDay(Date.UTC(2026, 9, 29, 22, 0))).toBe('2026-10-30');
  });

  it('a customer seen in both passes of the repeated hour is one customer', async () => {
    await inDo('fn-d1', async (sql) => {
      expect(await recordFunnelStep(sql, { step: 'browse', waId: WA, now: Date.UTC(2026, 9, 29, 20, 30) })).toBe(true);
      expect(await recordFunnelStep(sql, { step: 'browse', waId: WA, now: Date.UTC(2026, 9, 29, 21, 30) })).toBe(false);
    });
  });

  it('on the spring-forward night the rollup is due at the first real hour after midnight, 22:00Z', async () => {
    await inDo('fn-d2', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: Date.UTC(2026, 3, 23, 20, 0) }); // 22:00 on 04-23
      expect(all(sql, "SELECT due_at FROM scheduled_tasks WHERE kind = 'funnel_rollup'")).toEqual([{ due_at: Date.UTC(2026, 3, 23, 22, 0) }]);
    });
  });
});

describe('rollup', () => {
  it('turns past days into counts, deletes their markers and salts, and leaves today alone', async () => {
    await inDo('fn-u1', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T });
      await recordFunnelStep(sql, { step: 'browse', waId: WA2, now: T });
      await recordFunnelStep(sql, { step: 'order', waId: WA, now: T });
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T + DAY });
      const next = funnelRollup(sql, T + DAY + 3_600_000);
      expect(all(sql, 'SELECT day, step, customers FROM bot_funnel_daily ORDER BY step')).toEqual([{ day: '2026-06-10', step: 'browse', customers: 2 }, { day: '2026-06-10', step: 'order', customers: 1 }]);
      expect(all(sql, 'SELECT day FROM bot_funnel_markers')).toEqual([{ day: '2026-06-11' }]);
      expect(all(sql, 'SELECT day FROM bot_funnel_salt')).toEqual([{ day: '2026-06-11' }]);
      expect(next).toBe(Date.UTC(2026, 5, 11, 22, 0)); // today still has markers: roll again tomorrow
    });
  });

  it('is idempotent, and returns nothing to schedule once no markers remain', async () => {
    await inDo('fn-u2', async (sql) => {
      await recordFunnelStep(sql, { step: 'cart', waId: WA, now: T });
      expect(funnelRollup(sql, T + DAY)).toBeUndefined();
      expect(funnelRollup(sql, T + DAY)).toBeUndefined();
      expect(all(sql, 'SELECT day, step, customers FROM bot_funnel_daily')).toEqual([{ day: '2026-06-10', step: 'cart', customers: 1 }]);
      expect(all(sql, 'SELECT * FROM bot_funnel_salt')).toEqual([]);
    });
  });

  it('on the fall-back date rolls up the 29th, not the 30th, at 22:30Z', async () => {
    await inDo('fn-u3', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: Date.UTC(2026, 9, 29, 21, 30) });
      await recordFunnelStep(sql, { step: 'browse', waId: WA2, now: Date.UTC(2026, 9, 29, 22, 5) }); // already the 30th
      funnelRollup(sql, Date.UTC(2026, 9, 29, 22, 30));
      expect(all(sql, 'SELECT day, customers FROM bot_funnel_daily')).toEqual([{ day: '2026-10-29', customers: 1 }]);
      expect(all(sql, 'SELECT day FROM bot_funnel_markers')).toEqual([{ day: '2026-10-30' }]);
    });
  });
});

describe('erasure', () => {
  it('removes that customer\'s unrolled markers (today and a day not yet rolled up) and no one else\'s; rollups are untouched', async () => {
    await inDo('fn-e1', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T });
      await recordFunnelStep(sql, { step: 'browse', waId: WA2, now: T });
      await recordFunnelStep(sql, { step: 'cart', waId: WA, now: T + DAY });
      await recordFunnelStep(sql, { step: 'cart', waId: WA2, now: T + DAY });
      await eraseFunnelMarkers(sql, WA);
      expect(all(sql, 'SELECT day, step FROM bot_funnel_markers ORDER BY day')).toEqual([{ day: '2026-06-10', step: 'browse' }, { day: '2026-06-11', step: 'cart' }]);
      // after the rollup only counts exist: nothing to erase, and the counts stay
      funnelRollup(sql, T + 3 * DAY);
      await eraseFunnelMarkers(sql, WA2);
      expect(all(sql, 'SELECT customers FROM bot_funnel_daily')).toEqual([{ customers: 1 }, { customers: 1 }]);
    });
  });

  it('eraseContact in the workspace removes the markers', async () => {
    const ws = workspace('fn-e2');
    await ws.ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'fn-e2.1', from: WA, ts: 1, type: 'text', text: 'hi' }], statuses: [], receivedAt: 1 });
    await inDo('fn-e2', async (sql) => { await recordFunnelStep(sql, { step: 'browse', waId: WA, now: Date.now() }); await recordFunnelStep(sql, { step: 'browse', waId: WA2, now: Date.now() }); });
    await ws.eraseContact(WA);
    expect(await inDo('fn-e2', (sql) => all(sql, 'SELECT count(*) AS n FROM bot_funnel_markers'))).toEqual([{ n: 1 }]);
  });
});

describe('privacy by schema', () => {
  it('no analytics table has a column that could hold a person or a message', async () => {
    await inDo('fn-s1', (sql) => {
      const cols = (t: string) => all<{ name: string }>(sql, `SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
      expect(cols('bot_funnel_markers')).toEqual(['day', 'step', 'token']);
      expect(cols('bot_funnel_daily')).toEqual(['day', 'step', 'customers']);
      expect(cols('bot_funnel_salt')).toEqual(['day', 'salt']);
      for (const t of ['bot_funnel_markers', 'bot_funnel_daily', 'bot_funnel_salt']) {
        for (const c of cols(t)) expect(c).not.toMatch(/phone|wa_?id|name|buyer|text|body|message|contact|profile|address|email/i);
      }
    });
  });
});

describe('the scheduled rollup', () => {
  it('runs from the workspace scheduler and clears the day\'s markers', async () => {
    const ws = workspace('fn-t1');
    await inDo('fn-t1', async (sql) => {
      await recordFunnelStep(sql, { step: 'browse', waId: WA, now: T });
      sql.exec("UPDATE scheduled_tasks SET due_at = 1 WHERE kind = 'funnel_rollup'");
    });
    await ws.runDueTasks(T + DAY);
    expect(await inDo('fn-t1', (sql) => [all(sql, 'SELECT day, step, customers FROM bot_funnel_daily'), all(sql, 'SELECT * FROM bot_funnel_markers'), all(sql, "SELECT * FROM scheduled_tasks WHERE kind = 'funnel_rollup'")]))
      .toEqual([[{ day: '2026-06-10', step: 'browse', customers: 1 }], [], []]);
  });
});
